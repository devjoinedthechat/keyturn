-- Keyturn, proposal views.
--
-- For each protected table there is a view of the same name in the schema "proposal". An
-- agent writes ordinary SQL against the view:
--
--   update proposal.orders set status = 'refunded' where id = 1042;
--
-- Nothing is written. Each row the statement would have changed is recorded, and the
-- statement reports no rows changed, which is the truth. Everything recorded in one
-- transaction is one proposal.
--
-- A view is built so that it cannot become a way in:
--
--   * It reads the table with the caller's own rights (security_invoker), so privileges and
--     row-level security decide which rows the agent's statement can reach.
--   * It is not a view PostgreSQL would write through by itself, so if its trigger were
--     ever missing, a write would be an error and not a write.
--
-- Needs PostgreSQL 15 or later. On 14, propose() works and the views are not made.

create schema proposal;
grant usage on schema proposal to keyturn_agent;

alter table keyturn.protected add column view regclass;

-- Set for a proposal that is being put together by statements against the views: the
-- transaction it belongs to. Changes are added to it only from inside that transaction.
alter table keyturn.proposals add column transaction xid8;
-- A view belongs to one table, and the trigger on it finds that table by it, once a row.
create unique index protected_by_view on keyturn.protected (view) where view is not null;
create index proposals_in_transaction on keyturn.proposals (proposed_by, transaction) where transaction is not null;

-- Runs once for each row a statement against a view would have changed. Records the row and
-- lets nothing through: a trigger that returns nothing tells PostgreSQL the row was left alone.
create function keyturn.capture() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, pg_temp
  -- This runs once a row, and looks its proposal's rows up each time. A plan made while the
  -- table looked empty would read all of them every time: ten thousand rows, a hundred
  -- million reads. Every lookup here has an index, and this has the planner use it.
  set enable_seqscan = off
  -- Compiling a query that reads one row costs many times what the query does.
  set jit = off
  set timezone = 'UTC' set datestyle = 'ISO, YMD' set intervalstyle = 'iso_8601'
  set extra_float_digits = 3 set bytea_output = 'hex' set lc_monetary = 'C'
  as $$
<<row_>>
declare
  target    keyturn.protected;
  proposal  uuid;
  operation text := lower(tg_op);
  before    jsonb;
  after     jsonb;
  key       jsonb;
  columns   text[];
  seq       integer;
  forbidden text;
begin
  select * into target from keyturn.protected where view = tg_relid;
  if target.relation is null then
    raise exception 'keyturn: % is not a proposal view', tg_relid::regclass;
  end if;
  if not keyturn.caller_is('keyturn_agent') then
    raise exception 'keyturn: % is not an agent', session_user using errcode = 'insufficient_privilege';
  end if;
  if target.shape is distinct from keyturn.shape_of(target.relation) then
    raise exception 'keyturn: % has changed shape since it was protected; protect it again', target.relation;
  end if;

  -- The old row is the one the statement found, read through the view with the caller's own rights.
  if operation <> 'insert' then
    before := to_jsonb(old) - target.derived;
    key := (select jsonb_object_agg(entry.key, entry.value) from jsonb_each(before) as entry where entry.key = any (target.key_columns));
  end if;

  if operation = 'update' then
    after := to_jsonb(new) - target.derived;
    select coalesce(array_agg(entry.key order by entry.key), '{}') into columns
      from jsonb_each(after) as entry where entry.value is distinct from before -> entry.key;
    if columns && target.key_columns then
      raise exception 'keyturn: a primary key is not changed by an update; delete the row and insert another';
    end if;
    -- A statement that sets a row to what it already is changes nothing, and proposes nothing.
    if cardinality(columns) = 0 then
      return null;
    end if;
  elsif operation = 'insert' then
    -- A view cannot tell a column left out from one set to null. Both mean "not given": the
    -- table's own default, if it has one, is applied when the row is really inserted.
    select coalesce(array_agg(entry.key order by entry.key), '{}'), jsonb_object_agg(entry.key, entry.value) into columns, after
      from jsonb_each(to_jsonb(new) - target.derived) as entry where jsonb_typeof(entry.value) <> 'null';
    if after is null then
      raise exception 'keyturn: an insert gives at least one value';
    end if;
    if exists (select from pg_attribute where attrelid = target.relation and attname = any (columns) and attidentity = 'a') then
      raise exception 'keyturn: % numbers its rows itself; an insert gives no value for that column', target.relation;
    end if;
    key := coalesce((select jsonb_object_agg(entry.key, entry.value) from jsonb_each(after) as entry where entry.key = any (target.key_columns)), '{}'::jsonb);
    -- A key the table makes part of is not known yet. Half a key would name the wrong row.
    if not (key ?& target.key_columns) then
      key := '{}'::jsonb;
    end if;
  else
    columns := '{}';
  end if;

  -- The proposal this transaction is putting together, if it has started one.
  select id into proposal from keyturn.proposals
   where proposed_by = session_user and transaction = pg_current_xact_id() and status = 'pending';
  if proposal is null then
    perform keyturn.room_for_another();
    insert into keyturn.proposals (proposed_by, note, expires_at, transaction)
      values (session_user, left(coalesce(current_setting('keyturn.note', true), ''), 2000), clock_timestamp() + interval '1 day', pg_current_xact_id())
      returning id into proposal;
    raise notice 'keyturn: nothing is written. This is recorded as proposal %, to be approved by someone else.', proposal;
    perform keyturn.audit_append(proposal, 'opened', '{}');
  end if;

  if key <> '{}'::jsonb and exists (select from keyturn.changes c where c.proposal_id = proposal and c.relation = target.relation and c.key = row_.key and c.key <> '{}'::jsonb) then
    raise exception 'keyturn: the row % of % already has a change in this proposal', key, target.relation;
  end if;
  select coalesce(max(c.seq), 0) + 1 into seq from keyturn.changes c where c.proposal_id = proposal;
  if seq > 10000 then
    raise exception 'keyturn: a proposal holds at most 10000 changes, and this reaches more. Nothing is recorded. Narrow the statement, or make the change in parts';
  end if;

  forbidden := keyturn.forbidden_by(target.relation, operation, before, after);
  if forbidden is not null then
    raise exception 'keyturn: forbidden by the rule %. Nothing is recorded', forbidden using errcode = 'insufficient_privilege';
  end if;

  insert into keyturn.changes (proposal_id, seq, relation, relation_name, shape, operation, key, before, after, columns)
    values (proposal, seq, target.relation, keyturn.name_of(target.relation), target.shape, operation, key, before, after, columns);
  return null;
end $$;

-- The proposal the current transaction has put together so far, with the hash an approver will be asked for.
create function keyturn.proposed() returns table (proposal_id uuid, content_hash text, changes bigint)
  language sql stable
  set search_path = pg_catalog, pg_temp
  as $$
    select p.id, keyturn.hash_of(p.id), (select count(*) from keyturn.changes c where c.proposal_id = p.id)
      from keyturn.proposals p
     where p.proposed_by = session_user and p.transaction = pg_current_xact_id()
  $$;

-- Says why, for the proposal this transaction makes. Call it before or after the statements.
create function keyturn.note(p_note text) returns void
  language plpgsql security definer
  set search_path = pg_catalog, pg_temp
  as $$
begin
  if length(coalesce(p_note, '')) > 2000 then
    raise exception 'keyturn: a note is at most 2000 characters';
  end if;
  perform set_config('keyturn.note', coalesce(p_note, ''), true);
  update keyturn.proposals set note = coalesce(p_note, '')
   where proposed_by = session_user and transaction = pg_current_xact_id() and status = 'pending';
end $$;

-- Protecting a table also makes its view, and making it again replaces the view.
create or replace function keyturn.protect(p_relation regclass, p_exact boolean default true) returns void
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
declare
  key_columns text[];
  view_name   text;
begin
  select array_agg(attname::text order by ordinality) into key_columns
    from pg_index
    join unnest(indkey) with ordinality as key (attnum, ordinality) on true
    join pg_attribute on attrelid = indrelid and pg_attribute.attnum = key.attnum
   where indrelid = p_relation and indisprimary;
  if key_columns is null then
    raise exception 'keyturn: % has no primary key, so its rows cannot be named', p_relation;
  end if;

  insert into keyturn.protected (relation, key_columns, shape, derived, exact)
    values (p_relation, key_columns, keyturn.shape_of(p_relation),
            coalesce((select array_agg(attname::text order by attnum) from pg_attribute
                       where attrelid = p_relation and attnum > 0 and not attisdropped and attgenerated <> ''), '{}'),
            p_exact)
    on conflict (relation) do update
      set key_columns = excluded.key_columns, shape = excluded.shape, derived = excluded.derived, exact = excluded.exact;

  if current_setting('server_version_num')::integer < 150000 then
    raise notice 'keyturn: proposal views need PostgreSQL 15 or later. % is protected; use keyturn.propose().', p_relation;
    return;
  end if;

  select case when nspname = 'public' then relname::text else nspname || '_' || relname end into view_name
    from pg_class join pg_namespace on pg_namespace.oid = relnamespace where pg_class.oid = p_relation;
  if exists (select from keyturn.protected where view = to_regclass(format('proposal.%I', view_name)) and relation <> p_relation) then
    raise exception 'keyturn: the view proposal.% is already taken by another table', view_name;
  end if;

  update keyturn.protected set view = null where relation = p_relation;
  execute format('drop view if exists proposal.%I', view_name);
  -- Written with a WITH clause, which changes no row and makes the view one PostgreSQL will
  -- not write through by itself: were the trigger ever missing, a write would have nowhere
  -- to go. Unlike "offset 0", it leaves the planner free to use the table's indexes, so a
  -- statement that names one row reads one row.
  execute format('create view proposal.%I with (security_invoker = true) as with rows as (select * from %s) select * from rows', view_name, p_relation);
  execute format('create trigger capture instead of insert or update or delete on proposal.%I for each row execute function keyturn.capture()', view_name);
  execute format('grant select, insert, update, delete on proposal.%I to keyturn_agent', view_name);
  update keyturn.protected set view = format('proposal.%I', view_name)::regclass where relation = p_relation;
end $$;

-- Drops a table's view and leaves the table protected. A view holds on to the columns it
-- shows, so PostgreSQL refuses to drop or retype one of them while the view stands. Call
-- this before such a migration and keyturn.protect() after it. In between, propose() works.
create function keyturn.drop_view(p_relation regclass) returns void
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
declare
  target keyturn.protected;
begin
  select * into target from keyturn.protected where relation = p_relation;
  if target.view is not null then
    update keyturn.protected set view = null where relation = p_relation;
    execute format('drop view if exists %s', target.view);
  end if;
end $$;

-- Takes a table out of Keyturn's care. Its view goes, and proposals for it that were still
-- open are closed as stale: they can no longer be applied. What was proposed is kept.
create function keyturn.unprotect(p_relation regclass) returns void
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
declare
  target keyturn.protected;
  closed record;
begin
  select * into target from keyturn.protected where relation = p_relation;
  if target.relation is null then
    raise exception 'keyturn: % is not a table under keyturn', p_relation;
  end if;
  if target.view is not null then
    execute format('drop view if exists %s', target.view);
  end if;
  for closed in
    update keyturn.proposals set status = 'stale', finished_at = clock_timestamp(),
           outcome = jsonb_build_object('status', 'stale', 'reason', format('%s is no longer under keyturn', p_relation))
     where status in ('pending', 'approved') and id in (select proposal_id from keyturn.changes where relation = p_relation)
    returning id, outcome
  loop
    perform keyturn.audit_append(closed.id, 'stale', closed.outcome);
  end loop;
  delete from keyturn.rules where relation = p_relation;
  delete from keyturn.forbidden where relation = p_relation;
  delete from keyturn.protected where relation = p_relation;
end $$;

revoke all on function keyturn.capture(), keyturn.proposed(), keyturn.note(text), keyturn.unprotect(regclass), keyturn.drop_view(regclass) from public;
grant execute on function keyturn.proposed(), keyturn.note(text) to keyturn_agent;
