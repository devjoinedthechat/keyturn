-- Keyturn, core.
--
-- An agent's database role cannot change a protected table. It can record a proposal: the
-- rows it wants to change, as they are now and as they would be. A different login approves
-- that exact proposal. Only then does the database apply it, and only if the rows still look
-- the way they did when the proposal was made.
--
-- Run this file once, as the role that owns the tables to protect. Nothing connects as that
-- role at run time.
--
--   keyturn_agent      may propose and may ask for an approved proposal to be applied
--   keyturn_approver   may approve and reject
--
-- Both are groups. A login is put in one of them, never in both.

create schema keyturn;

do $$
begin
  if not exists (select from pg_roles where rolname = 'keyturn_agent') then
    create role keyturn_agent nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'keyturn_approver') then
    create role keyturn_approver nologin;
  end if;
end $$;

-- A table under Keyturn's care. Its shape is remembered, so a proposal made against one
-- shape is never applied to another.
create table keyturn.protected (
  relation    regclass    primary key,
  key_columns text[]      not null check (cardinality(key_columns) > 0),
  shape       text        not null,
  -- Columns the table works out from the others. They are left out of every row image: they
  -- say nothing the other columns do not, and they change when those do.
  derived     text[]      not null default '{}',
  -- Whether a row that comes out of an apply different from what was approved (a trigger or
  -- a default changed it) fails the apply. It does, unless the table's owner says otherwise.
  exact       boolean     not null default true,
  added_at    timestamptz not null default clock_timestamp()
);

create table keyturn.proposals (
  id           uuid        primary key default gen_random_uuid(),
  -- The login that made it. Taken from the connection, never from anything the caller passes.
  proposed_by  name        not null,
  note         text        not null default '' check (length(note) <= 2000),
  content_hash text        not null,
  status       text        not null default 'pending'
                 check (status in ('pending', 'approved', 'rejected', 'applied', 'stale', 'failed')),
  proposed_at  timestamptz not null default clock_timestamp(),
  expires_at   timestamptz not null,
  decided_by   name,
  decided_at   timestamptz,
  reason       text check (reason is null or length(reason) <= 2000),
  finished_at  timestamptz,
  outcome      jsonb,
  check ((status in ('pending')) = (decided_by is null)),
  -- Nobody approves or rejects their own proposal.
  check (decided_by is null or decided_by <> proposed_by)
);

-- One row of one proposal: the row as it was when proposed, and as it would be.
create table keyturn.changes (
  proposal_id uuid     not null references keyturn.proposals (id),
  seq         integer  not null,
  relation    regclass not null references keyturn.protected (relation),
  shape       text     not null,
  operation   text     not null check (operation in ('insert', 'update', 'delete')),
  key         jsonb    not null,
  before      jsonb,
  after       jsonb,
  -- The columns the proposal sets. Only these are written on apply.
  columns     text[]   not null,
  primary key (proposal_id, seq),
  check ((operation = 'insert') = (before is null)),
  check ((operation = 'delete') = (after is null))
);

-- ---------------------------------------------------------------- how a row is written down

-- A row is compared and hashed as JSON. JSON text depends on the session: a timestamp is
-- written in the session's time zone, a float with the session's digits. Every function
-- that reads or compares a row therefore runs with these settings, whatever the caller's are.
--
--   TimeZone UTC, DateStyle ISO, IntervalStyle iso_8601, extra_float_digits 3, bytea_output hex

-- What a table looks like: its columns, in order, with their types. Two tables with the
-- same text here hold rows that can be compared.
create function keyturn.shape_of(p_relation regclass) returns text
  language sql stable
  set search_path = pg_catalog
  as $$
    select string_agg(attname || ' ' || format_type(atttypid, atttypmod) || case when attgenerated <> '' then ' generated' else '' end, ', ' order by attnum)
      from pg_attribute
     where attrelid = p_relation and attnum > 0 and not attisdropped
  $$;

-- The condition that picks out one row by its key, for a row given as JSON in $1.
create function keyturn.key_condition(p_relation regclass, p_key_columns text[]) returns text
  language sql stable
  set search_path = pg_catalog
  as $$
    select string_agg(format('t.%1$I = (jsonb_populate_record(null::%2$s, $1)).%1$I', key_column, p_relation), ' and ')
      from unnest(p_key_columns) as key_column
  $$;

-- A row of a table, written down: every column but the ones the table works out itself.
-- "t" is the row in the query this is put into.
create function keyturn.image(p_derived text[]) returns text
  language sql immutable
  set search_path = pg_catalog
  as $$ select format('(to_jsonb(t) - %L::text[])', p_derived) $$;

-- ---------------------------------------------------------------- protecting a table

-- Puts a table under Keyturn's care. The table must have a primary key: a proposal names
-- the rows it changes by it.
create function keyturn.protect(p_relation regclass, p_exact boolean default true) returns void
  language plpgsql
  set search_path = pg_catalog
  as $$
declare
  key_columns text[];
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
end $$;

-- ---------------------------------------------------------------- proposing

-- Records a proposal and changes nothing.
--
-- p_changes is a list. Each entry names a table, an operation, and:
--
--   insert   "values": the columns to set
--   update   "key": the primary key; "set": the columns to change
--   delete   "key": the primary key
--
-- The rows are read here, as they are now, and kept. What is returned is the proposal's id
-- and the hash of its content, which is what an approver approves.
create function keyturn.record_proposal(p_changes jsonb, p_note text, p_valid_for interval)
  returns table (proposal_id uuid, content_hash text)
  language plpgsql security definer
  set search_path = pg_catalog
  set timezone = 'UTC' set datestyle = 'ISO, YMD' set intervalstyle = 'iso_8601'
  set extra_float_digits = 3 set bytea_output = 'hex'
  as $$
declare
  change    jsonb;
  target    keyturn.protected;
  operation text;
  key       jsonb;
  given     jsonb;
  before    jsonb;
  after     jsonb;
  columns   text[];
  unknown   text;
  seq       integer := 0;
  proposal  uuid := gen_random_uuid();
  digest    text;
begin
  if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) = 0 then
    raise exception 'keyturn: a proposal is a list of at least one change';
  end if;
  if jsonb_array_length(p_changes) > 10000 then
    raise exception 'keyturn: a proposal holds at most 10000 changes';
  end if;
  if p_valid_for <= interval '0' or p_valid_for > interval '30 days' then
    raise exception 'keyturn: a proposal is valid for up to 30 days';
  end if;

  -- The proposal's row comes first, so its changes can refer to it. Its hash is filled in below.
  insert into keyturn.proposals (id, proposed_by, note, content_hash, expires_at)
    values (proposal, session_user, coalesce(p_note, ''), '', clock_timestamp() + p_valid_for);

  for change in select value from jsonb_array_elements(p_changes) loop
    seq := seq + 1;
    operation := change ->> 'operation';
    begin
      -- propose() hands a table over as its id, which names it whatever the search path. A name is taken too, if it gives its schema.
      select * into target from keyturn.protected
       where relation = case when change ->> 'table' ~ '^[0-9]+$' then (change ->> 'table')::oid::regclass else (change ->> 'table')::regclass end;
    exception when undefined_table or invalid_text_representation or invalid_schema_name or numeric_value_out_of_range then
      target := null;
    end;
    if target.relation is null then
      raise exception 'keyturn: change %: % is not a table under keyturn', seq,
        coalesce(case when change ->> 'table' ~ '^[0-9]+$' then to_regclass((change ->> 'table')::oid::regclass::text)::text end, change ->> 'table', '(none)');
    end if;
    if target.shape <> keyturn.shape_of(target.relation) then
      raise exception 'keyturn: % has changed shape since it was protected; protect it again', target.relation;
    end if;

    given := case operation when 'insert' then change -> 'values' when 'update' then change -> 'set' else '{}'::jsonb end;
    if operation not in ('insert', 'update', 'delete') or jsonb_typeof(given) is distinct from 'object'
       or (operation <> 'delete' and given = '{}'::jsonb) then
      raise exception 'keyturn: change %: give "operation" insert with "values", update with "key" and "set", or delete with "key"', seq;
    end if;

    select array_agg(name order by name) into columns from jsonb_object_keys(given) as name;
    columns := coalesce(columns, '{}');
    select name into unknown from unnest(columns) as name
     where not exists (select from pg_attribute
                        where attrelid = target.relation and attname = name and attnum > 0 and not attisdropped and attgenerated = '');
    if unknown is not null then
      raise exception 'keyturn: change %: % has no column "%" that can be set', seq, target.relation, unknown;
    end if;

    if not has_table_privilege(session_user, target.relation, 'SELECT') then
      raise exception 'keyturn: change %: % may not read %', seq, session_user, target.relation using errcode = 'insufficient_privilege';
    end if;

    if operation = 'insert' then
      before := null;
      -- Passed through the table's own types, so that 1 and "1" and 1.0 are written one way.
      execute format('select to_jsonb(r) from jsonb_populate_record(null::%s, $1) r', target.relation) into after using given;
      after := (select jsonb_object_agg(entry.key, entry.value) from jsonb_each(after) as entry where entry.key = any (columns));
      key := (select jsonb_object_agg(entry.key, entry.value) from jsonb_each(after) as entry where entry.key = any (target.key_columns));
      key := coalesce(key, '{}'::jsonb);
    else
      key := change -> 'key';
      if jsonb_typeof(key) is distinct from 'object'
         or not (select array_agg(name order by name) from jsonb_object_keys(key) as name) = (select array_agg(name order by name) from unnest(target.key_columns) as name) then
        raise exception 'keyturn: change %: "key" must give exactly the primary key of %: %', seq, target.relation, target.key_columns;
      end if;
      if operation = 'update' and columns && target.key_columns then
        raise exception 'keyturn: change %: a primary key is not changed by an update; delete the row and insert another', seq;
      end if;

      execute format('select %s from %s t where %s', keyturn.image(target.derived), target.relation, keyturn.key_condition(target.relation, target.key_columns))
        into before using key;
      -- A proposal keeps the row it would change, and the proposer can read the proposal. So
      -- the proposer must already be able to read that row. propose() read it with the caller's
      -- own rights and handed it over as "seen"; it has to be the row that is really there.
      if before is null or change -> 'seen' is distinct from before then
        raise exception 'keyturn: change %: % has no row with key % that % can read', seq, target.relation, key, session_user;
      end if;
      key := (select jsonb_object_agg(entry.key, entry.value) from jsonb_each(before) as entry where entry.key = any (target.key_columns));

      if operation = 'update' then
        execute format('select %s from jsonb_populate_record(null::%s, $1) t', keyturn.image(target.derived), target.relation) into after using before || given;
        if after = before then
          raise exception 'keyturn: change %: the row already has these values', seq;
        end if;
      else
        after := null;
      end if;
    end if;

    insert into keyturn.changes (proposal_id, seq, relation, shape, operation, key, before, after, columns)
      values (proposal, seq, target.relation, target.shape, operation, key, before, after, columns);
  end loop;

  digest := keyturn.hash_of(proposal);
  update keyturn.proposals set content_hash = digest where id = proposal;
  return query select proposal, digest;
end $$;

-- What a caller uses. It runs with the caller's own rights, for two reasons.
--
-- A table named without its schema is found the way the caller would find it. And each row
-- to be changed is read here, by the caller, so that row-level security and privileges
-- decide what the caller can see. The recording function, which runs with its owner's
-- rights, takes a row only if the caller has shown it can read that very row.
create function keyturn.propose(p_changes jsonb, p_note text default '', p_valid_for interval default interval '1 day')
  returns table (proposal_id uuid, content_hash text)
  language plpgsql
  set timezone = 'UTC' set datestyle = 'ISO, YMD' set intervalstyle = 'iso_8601'
  set extra_float_digits = 3 set bytea_output = 'hex'
  as $$
declare
  change   jsonb;
  position bigint;
  target   keyturn.protected;
  seen     jsonb;
  named    jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_changes) is distinct from 'array' then
    return query select * from keyturn.record_proposal(p_changes, p_note, p_valid_for);
    return;
  end if;

  for change, position in select listed.change, listed.position from jsonb_array_elements(p_changes) with ordinality as listed (change, position) loop
    if jsonb_typeof(change) = 'object' and to_regclass(change ->> 'table') is not null then
      select * into target from keyturn.protected where relation = to_regclass(change ->> 'table');
      change := (change - 'seen') || jsonb_build_object('table', to_regclass(change ->> 'table')::oid::text);
      if target.relation is not null and change ->> 'operation' in ('update', 'delete') and jsonb_typeof(change -> 'key') = 'object' then
        begin
          execute format('select %s from %s t where %s', keyturn.image(target.derived), target.relation, keyturn.key_condition(target.relation, target.key_columns))
            into seen using change -> 'key';
        exception when insufficient_privilege then
          seen := null;
        end;
        change := change || jsonb_build_object('seen', seen);
      end if;
    end if;
    named := named || jsonb_build_array(change);
  end loop;
  return query select * from keyturn.record_proposal(named, p_note, p_valid_for);
end $$;

-- The hash of a proposal's content: every change, in order, with the note. jsonb writes its
-- keys in one order and its numbers one way, so the same content always gives the same text.
create function keyturn.hash_of(p_proposal_id uuid) returns text
  language sql stable
  set search_path = pg_catalog
  as $$
    select encode(sha256(convert_to(jsonb_build_object(
             'note', (select note from keyturn.proposals where id = p_proposal_id),
             'changes', jsonb_agg(jsonb_build_object(
               'table', relation::text, 'shape', shape, 'operation', operation,
               'key', key, 'before', before, 'after', after, 'columns', columns) order by seq))::text, 'UTF8')), 'hex')
      from keyturn.changes
     where proposal_id = p_proposal_id
  $$;

-- ---------------------------------------------------------------- deciding

-- Whether the login on this connection is in a group. The login is what counts: a function
-- that runs with its owner's rights still sees who connected.
create function keyturn.caller_is(p_group name) returns boolean
  language sql stable
  set search_path = pg_catalog
  as $$ select pg_has_role(session_user, p_group, 'MEMBER') $$;

-- Approves a proposal. The approver says which content they are approving, by its hash. If
-- that is not what the proposal holds, nothing is approved.
create function keyturn.approve(p_proposal_id uuid, p_content_hash text) returns void
  language plpgsql security definer
  set search_path = pg_catalog
  as $$
declare
  proposal keyturn.proposals;
begin
  if not keyturn.caller_is('keyturn_approver') then
    raise exception 'keyturn: % is not an approver', session_user using errcode = 'insufficient_privilege';
  end if;
  select * into proposal from keyturn.proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'keyturn: no such proposal';
  end if;
  if proposal.proposed_by = session_user then
    raise exception 'keyturn: a proposal is not approved by the login that made it' using errcode = 'insufficient_privilege';
  end if;
  if proposal.status <> 'pending' then
    raise exception 'keyturn: the proposal is %, not pending', proposal.status;
  end if;
  if proposal.expires_at <= clock_timestamp() then
    raise exception 'keyturn: the proposal expired at %', proposal.expires_at;
  end if;
  -- Held against what is stored now, not against the hash written when it was proposed.
  if p_content_hash is distinct from keyturn.hash_of(p_proposal_id) or p_content_hash is distinct from proposal.content_hash then
    raise exception 'keyturn: that is not the content of this proposal';
  end if;
  update keyturn.proposals set status = 'approved', decided_by = session_user, decided_at = clock_timestamp()
   where id = p_proposal_id;
end $$;

create function keyturn.reject(p_proposal_id uuid, p_reason text default null) returns void
  language plpgsql security definer
  set search_path = pg_catalog
  as $$
declare
  proposal keyturn.proposals;
begin
  if not keyturn.caller_is('keyturn_approver') then
    raise exception 'keyturn: % is not an approver', session_user using errcode = 'insufficient_privilege';
  end if;
  select * into proposal from keyturn.proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'keyturn: no such proposal';
  end if;
  if proposal.proposed_by = session_user then
    raise exception 'keyturn: a proposal is not decided by the login that made it' using errcode = 'insufficient_privilege';
  end if;
  if proposal.status <> 'pending' then
    raise exception 'keyturn: the proposal is %, not pending', proposal.status;
  end if;
  update keyturn.proposals set status = 'rejected', decided_by = session_user, decided_at = clock_timestamp(), reason = p_reason
   where id = p_proposal_id;
end $$;

-- ---------------------------------------------------------------- applying

-- Carries out an approved proposal, all of it or none of it, once.
--
-- Anyone who may use Keyturn may ask: asking is harmless, since nothing happens unless the
-- proposal is approved, unexpired, unaltered, and every row it touches is as it was.
--
-- Returns what became of it: applied, stale, or failed, with the reason.
create function keyturn.apply(p_proposal_id uuid) returns jsonb
  language plpgsql security definer
  set search_path = pg_catalog
  set timezone = 'UTC' set datestyle = 'ISO, YMD' set intervalstyle = 'iso_8601'
  set extra_float_digits = 3 set bytea_output = 'hex'
  as $$
declare
  proposal keyturn.proposals;
  change   keyturn.changes;
  target   keyturn.protected;
  locate   text;
  current_ jsonb;
  written  jsonb;
  touched  bigint;
  result   jsonb;
begin
  if not (keyturn.caller_is('keyturn_agent') or keyturn.caller_is('keyturn_approver')) then
    raise exception 'keyturn: % may not use keyturn', session_user using errcode = 'insufficient_privilege';
  end if;

  -- One caller at a time holds the proposal. A second waits here, then sees what the first did.
  select * into proposal from keyturn.proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'keyturn: no such proposal';
  end if;
  if proposal.status in ('applied', 'stale', 'failed') then
    return proposal.outcome;
  end if;
  if proposal.status <> 'approved' then
    raise exception 'keyturn: the proposal is %, not approved', proposal.status using errcode = 'insufficient_privilege';
  end if;
  if proposal.expires_at <= clock_timestamp() then
    raise exception 'keyturn: the proposal expired at %', proposal.expires_at;
  end if;
  if proposal.content_hash is distinct from keyturn.hash_of(p_proposal_id) then
    raise exception 'keyturn: the proposal is not what was approved';
  end if;

  -- First pass: every row the proposal touches is locked and held against what was recorded.
  -- Nothing is written until all of them match.
  for change in select * from keyturn.changes where proposal_id = p_proposal_id order by seq loop
    select * into target from keyturn.protected where relation = change.relation;
    if target.relation is null or change.shape <> keyturn.shape_of(change.relation) then
      result := jsonb_build_object('status', 'stale', 'change', change.seq, 'reason', format('%s has changed shape since the proposal was made', change.relation));
      exit;
    end if;
    locate := keyturn.key_condition(change.relation, target.key_columns);
    execute format('select %s from %s t where %s for update', keyturn.image(target.derived), change.relation, locate) into current_ using change.key;
    if current_ is distinct from change.before then
      result := jsonb_build_object('status', 'stale', 'change', change.seq, 'reason', case
        when change.operation = 'insert' then format('%s already has a row with key %s', change.relation, change.key)
        when current_ is null then format('the row %s of %s is gone', change.key, change.relation)
        else format('the row %s of %s has changed since the proposal was made', change.key, change.relation) end);
      exit;
    end if;
  end loop;

  if result is not null then
    update keyturn.proposals set status = 'stale', outcome = result, finished_at = clock_timestamp() where id = p_proposal_id;
    return result;
  end if;

  -- Second pass: the writes. If one of them fails, or a row does not come out as approved,
  -- everything written here is undone and the proposal is marked failed.
  begin
    for change in select * from keyturn.changes where proposal_id = p_proposal_id order by seq loop
      select * into target from keyturn.protected where relation = change.relation;
      locate := keyturn.key_condition(change.relation, target.key_columns);
      -- Each write hands back the row as it was written, which is what gets held against the approval.
      written := null;
      if change.operation = 'insert' then
        execute format('insert into %1$s as t (%2$s) select %2$s from jsonb_populate_record(null::%1$s, $1) returning %3$s',
          change.relation, (select string_agg(format('%I', name), ', ') from unnest(change.columns) as name), keyturn.image(target.derived)) into written using change.after;
      elsif change.operation = 'update' then
        -- The row set is one column wide or many; "row" makes the two cases read alike.
        execute format('update %1$s t set (%2$s) = (select %2$s from jsonb_populate_record(null::%1$s, $2)) where %3$s returning %4$s',
          change.relation, (select string_agg(format('%I', name), ', ') from unnest(change.columns) as name), locate, keyturn.image(target.derived))
          into written using change.key, change.after;
      else
        execute format('delete from %s t where %s', change.relation, locate) using change.key;
      end if;
      get diagnostics touched = row_count;
      if touched <> 1 then
        raise exception 'keyturn: change % touched % rows, not 1', change.seq, touched using errcode = 'KT001';
      end if;

      -- A trigger or a default on the table may have written something other than what was approved.
      if target.exact and change.operation = 'insert' and not coalesce(written @> change.after, false) then
        raise exception 'keyturn: change %: the inserted row is not what was approved', change.seq using errcode = 'KT001';
      end if;
      if target.exact and change.operation = 'update' and written is distinct from change.after then
        raise exception 'keyturn: change %: the row is not what was approved after the write', change.seq using errcode = 'KT001';
      end if;
    end loop;
  exception when others then
    result := jsonb_build_object('status', 'failed', 'reason', sqlerrm);
    update keyturn.proposals set status = 'failed', outcome = result, finished_at = clock_timestamp() where id = p_proposal_id;
    return result;
  end;

  result := jsonb_build_object('status', 'applied', 'changes', (select count(*) from keyturn.changes where proposal_id = p_proposal_id));
  update keyturn.proposals set status = 'applied', outcome = result, finished_at = clock_timestamp() where id = p_proposal_id;
  return result;
end $$;

-- ---------------------------------------------------------------- who may see what

-- A proposal holds rows of the tables it would change. An agent reads the proposals it made
-- and no others. An approver reads them all: reading them is the approver's job.
alter table keyturn.proposals enable row level security;
alter table keyturn.changes enable row level security;

create policy own_or_approver on keyturn.proposals for select
  using (proposed_by = session_user or pg_has_role(session_user, 'keyturn_approver', 'MEMBER'));
create policy own_or_approver on keyturn.changes for select
  using (pg_has_role(session_user, 'keyturn_approver', 'MEMBER')
         or exists (select from keyturn.proposals where proposals.id = changes.proposal_id and proposals.proposed_by = session_user));

-- ---------------------------------------------------------------- who may do what

revoke all on schema keyturn from public;
revoke all on all tables in schema keyturn from public;
revoke all on all functions in schema keyturn from public;

grant usage on schema keyturn to keyturn_agent, keyturn_approver;
-- Both may read proposals and their changes. Neither may write them: only the functions do.
grant select on keyturn.proposals, keyturn.changes, keyturn.protected to keyturn_agent, keyturn_approver;
grant execute on function keyturn.propose(jsonb, text, interval), keyturn.record_proposal(jsonb, text, interval) to keyturn_agent;
grant execute on function keyturn.apply(uuid) to keyturn_agent, keyturn_approver;
grant execute on function keyturn.approve(uuid, text), keyturn.reject(uuid, text) to keyturn_approver;
grant execute on function keyturn.hash_of(uuid), keyturn.caller_is(name), keyturn.shape_of(regclass), keyturn.key_condition(regclass, text[]), keyturn.image(text[]) to keyturn_agent, keyturn_approver;
