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

do $$
begin
  -- The proposal views run with the caller's rights (security_invoker), which came with PostgreSQL 15.
  if current_setting('server_version_num')::integer < 150000 then
    raise exception 'keyturn needs PostgreSQL 15 or later; this is %', current_setting('server_version');
  end if;
end $$;

create schema keyturn;

do $$
begin
  if not exists (select from pg_roles where rolname = 'keyturn_agent') then
    create role keyturn_agent nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'keyturn_approver') then
    create role keyturn_approver nologin;
  end if;
  -- Nothing logs in as this one and nothing is granted to it. It is the name on record when
  -- one of the owner's rules, and no person, let a change through; holding the name keeps a
  -- login from taking it.
  if not exists (select from pg_roles where rolname = 'keyturn_rule') then
    create role keyturn_rule nologin;
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
  -- The hash of the content that was approved. Empty until someone approves: before that
  -- there is nothing to hold the content to, and what a reviewer is shown is worked out afresh.
  content_hash text,
  status       text        not null default 'pending'
                 check (status in ('pending', 'approved', 'rejected', 'applied', 'stale', 'failed', 'reverted')),
  proposed_at  timestamptz not null default clock_timestamp(),
  expires_at   timestamptz not null,
  decided_by   name,
  decided_at   timestamptz,
  reason       text check (reason is null or length(reason) <= 2000),
  finished_at  timestamptz,
  outcome      jsonb,
  -- Nothing undecided has a decider, and nothing approved lacks one or lacks the hash that was approved.
  check (status <> 'pending' or decided_by is null),
  check (status not in ('approved', 'rejected', 'applied', 'reverted') or decided_by is not null),
  check (status not in ('pending', 'rejected') or content_hash is null),
  check (status not in ('approved', 'applied', 'reverted') or content_hash is not null),
  -- Nobody approves or rejects their own proposal.
  check (decided_by is null or decided_by <> proposed_by)
);

-- One row of one proposal: the row as it was when proposed, and as it would be.
create table keyturn.changes (
  proposal_id uuid     not null references keyturn.proposals (id),
  seq         integer  not null,
  -- Not held to the list of protected tables: a proposal is kept after its table has left Keyturn's care.
  relation    regclass not null,
  -- The table's name, with its schema, when the change was proposed. It is what a reviewer
  -- read and what the hash covers; a table renamed, moved or dropped since no longer matches.
  relation_name text   not null,
  shape       text     not null,
  operation   text     not null check (operation in ('insert', 'update', 'delete')),
  key         jsonb    not null,
  before      jsonb,
  after       jsonb,
  -- The columns the proposal sets. Only these are written on apply.
  columns     text[]   not null,
  -- The row as the table held it after the write, where that is more than "after" says: an
  -- insert with the columns the table filled in, among them a key it made itself. Kept so
  -- that the change can be taken back. No part of the proposal's content or its hash.
  as_written  jsonb,
  primary key (proposal_id, seq),
  check ((operation = 'insert') = (before is null)),
  check ((operation = 'delete') = (after is null))
);
-- One change to a row in one proposal: a second would be approved against a row the first
-- had already altered. The functions say so in words; this makes it so, and makes the check
-- quick in a proposal of thousands of rows. An insert that leaves its key to a default has
-- no key yet, and is not counted.
create unique index one_change_per_row on keyturn.changes (proposal_id, relation, key) where key <> '{}'::jsonb;
create index changes_by_relation on keyturn.changes (relation);
-- The review queue, and the count of what one login has waiting.
create index proposals_waiting on keyturn.proposals (proposed_by, proposed_at) where status = 'pending';


-- What happened to each proposal, in order: opened, approved or rejected, and what became of
-- it. Written by Keyturn's functions in the same transaction as the thing it records, so
-- nothing happens without its entry. Each entry carries the hash of the one before it for
-- the same proposal, so an entry changed or removed afterwards shows.
create table keyturn.audit (
  seq         bigint      generated always as identity primary key,
  proposal_id uuid        not null,
  at          timestamptz not null default clock_timestamp(),
  -- The login on the connection.
  actor       name        not null default session_user,
  event       text        not null check (event in ('opened', 'approved', 'approved_by_rule', 'rejected', 'applied', 'stale', 'failed', 'reverted')),
  detail      jsonb       not null default '{}',
  prev_hash   text        not null,
  hash        text        not null
);
create index audit_by_proposal on keyturn.audit (proposal_id, seq);
create index audit_let_through on keyturn.audit (at) where event = 'approved_by_rule';

create function keyturn.refuse_change() returns trigger
  language plpgsql
  as $$ begin raise exception 'keyturn: the audit log is never changed or emptied'; end $$;
create trigger audit_is_append_only before update or delete on keyturn.audit for each row execute function keyturn.refuse_change();
create trigger audit_is_not_emptied before truncate on keyturn.audit execute function keyturn.refuse_change();

create function keyturn.audit_hash(p_prev text, p_proposal uuid, p_at timestamptz, p_actor name, p_event text, p_detail jsonb) returns text
  language sql immutable
  set search_path = pg_catalog, pg_temp
  as $$
    select encode(sha256(convert_to(p_prev || '|' || p_proposal || '|' || to_char(p_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US')
             || '|' || p_actor || '|' || p_event || '|' || p_detail::text, 'UTF8')), 'hex')
  $$;

-- Adds an entry. Called only by Keyturn's own functions, which hold the proposal's row
-- while they do, so a proposal's entries have one order.
create function keyturn.audit_append(p_proposal uuid, p_event text, p_detail jsonb default '{}') returns void
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
declare
  previous text;
  moment   timestamptz := clock_timestamp();
begin
  select hash into previous from keyturn.audit where proposal_id = p_proposal order by seq desc limit 1;
  previous := coalesce(previous, '');
  insert into keyturn.audit (proposal_id, at, event, detail, prev_hash, hash)
    values (p_proposal, moment, p_event, coalesce(p_detail, '{}'), previous,
            keyturn.audit_hash(previous, p_proposal, moment, session_user, p_event, coalesce(p_detail, '{}')));
end $$;

-- Rules for changes that need no person. There are none unless the tables' owner writes
-- one, and a change no rule covers waits for a person, as every change does by default.
--
-- A rule covers a change when the table and the operation are the rule's, an update sets
-- only columns the rule lists, and the rule's condition, if it has one, holds for the row
-- as it is ("before") and as it would be ("after"). A proposal is let through only when
-- every change in it is covered, it holds no more rows than the rules that cover it allow,
-- and none of those rules has already let through as many proposals as it may in an hour.
create table keyturn.rules (
  name       text        primary key check (name ~ '^[a-z][a-z0-9_]{0,62}$'),
  relation   regclass    not null,
  operations text[]      not null check (operations <@ array['insert', 'update', 'delete'] and cardinality(operations) > 0),
  -- For updates and inserts: the only columns that may be set. Null allows none, so a rule for updates or inserts must list them.
  columns    text[],
  max_rows   integer     not null default 1 check (max_rows between 1 and 10000),
  -- How many proposals the rule lets through in any hour. One row at a time is still every row, given enough proposals.
  per_hour   integer     not null default 60 check (per_hour between 1 and 100000),
  -- SQL that gives true or false, over two jsonb values named before and after.
  condition  text,
  active     boolean     not null default true,
  version    integer     not null default 1,
  written_by name        not null default session_user,
  written_at timestamptz not null default clock_timestamp()
);

-- The rules that together cover a proposal, or null when some change is covered by none.
create function keyturn.rules_covering(p_proposal_id uuid) returns jsonb
  language plpgsql stable
  set search_path = pg_catalog, pg_temp
  as $$
declare
  change  keyturn.changes;
  rule    keyturn.rules;
  holds   boolean;
  found   boolean;
  used    jsonb := '{}';
  total   integer;
begin
  select count(*) into total from keyturn.changes where proposal_id = p_proposal_id;
  for change in select * from keyturn.changes where proposal_id = p_proposal_id order by seq loop
    found := false;
    for rule in select * from keyturn.rules where active and relation = change.relation and change.operation = any (operations) and max_rows >= total order by name loop
      if change.operation <> 'delete' and not (change.columns <@ coalesce(rule.columns, '{}')) then
        continue;
      end if;
      if rule.condition is not null then
        begin
          execute format('select (%s) from (select $1 as before, $2 as after) as change', rule.condition) into holds using change.before, change.after;
        exception when others then
          -- A condition that cannot be worked out for this row does not hold for it.
          holds := false;
        end;
        if holds is not true then
          continue;
        end if;
      end if;
      found := true;
      used := used || jsonb_build_object(rule.name, rule.version);
      exit;
    end loop;
    if not found then
      return null;
    end if;
  end loop;
  return case when total > 0 then used end;
end $$;

-- Writes a rule, or replaces one of the same name with the next version. For the tables' owner.
create function keyturn.allow(name text, relation regclass, operations text[], columns text[] default null,
                              max_rows integer default 1, condition text default null, per_hour integer default 60) returns void
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
-- The parameters carry the names of the rule's columns, so that a call reads
-- "max_rows => 5". Inside, a bare name is the column and "allow.name" the parameter.
#variable_conflict use_column
declare
  unknown text;
begin
  if not exists (select from keyturn.protected p where p.relation = allow.relation) then
    raise exception 'keyturn: % is not a table under keyturn', allow.relation;
  end if;
  select wanted.name into unknown from unnest(coalesce(allow.columns, '{}')) as wanted (name)
   where not exists (select from pg_attribute a where a.attrelid = allow.relation and a.attname = wanted.name and a.attnum > 0 and not a.attisdropped);
  if unknown is not null then
    raise exception 'keyturn: % has no column "%"', allow.relation, unknown;
  end if;
  if allow.operations && array['insert', 'update'] and coalesce(cardinality(allow.columns), 0) = 0 then
    raise exception 'keyturn: a rule for inserts or updates lists the columns that may be set';
  end if;
  if allow.condition is not null then
    -- Tried once on an empty row, so that a condition that is not SQL is refused when it is written and not when it is needed.
    execute format('select (%s)::boolean from (select $1 as before, $2 as after) as change', allow.condition) using '{}'::jsonb, '{}'::jsonb;
  end if;
  insert into keyturn.rules (name, relation, operations, columns, max_rows, condition, per_hour)
    values (allow.name, allow.relation, allow.operations, allow.columns, allow.max_rows, allow.condition, allow.per_hour)
    on conflict (name) do update
      set relation = excluded.relation, operations = excluded.operations, columns = excluded.columns, max_rows = excluded.max_rows,
          condition = excluded.condition, per_hour = excluded.per_hour, active = true, version = keyturn.rules.version + 1,
          written_by = session_user, written_at = clock_timestamp();
end $$;

-- Rules for changes that no one may approve. A rule in keyturn.rules takes the person out of
-- a change that is small; a rule here takes the change out altogether. It is refused when it
-- is proposed, with the rule's reason, so that the agent learns why and the queue does not
-- fill with what must be turned down anyway. It is held against the rules again when a
-- person approves and when it is applied: the records a condition reads may have changed
-- while the proposal waited, and an approval does not lift a rule.
--
-- A condition is the same kind as in keyturn.rules: SQL over "before" and "after". A row it
-- cannot be worked out for, or for which it gives neither true nor false, is refused.
create table keyturn.forbidden (
  name       text        primary key check (name ~ '^[a-z][a-z0-9_]{0,62}$'),
  relation   regclass    not null,
  operations text[]      not null check (operations <@ array['insert', 'update', 'delete'] and cardinality(operations) > 0),
  condition  text        not null,
  -- Said to whoever proposed the change, and shown to an approver.
  reason     text        not null check (length(reason) between 1 and 500),
  active     boolean     not null default true,
  version    integer     not null default 1,
  written_by name        not null default session_user,
  written_at timestamptz not null default clock_timestamp()
);
create index forbidden_for on keyturn.forbidden (relation) where active;

-- The first rule that forbids a change, as its name and reason, or null when none does.
create function keyturn.forbidden_by(p_relation regclass, p_operation text, p_before jsonb, p_after jsonb) returns text
  language plpgsql stable
  set search_path = pg_catalog, pg_temp
  as $$
declare
  rule  keyturn.forbidden;
  holds boolean;
begin
  for rule in select * from keyturn.forbidden where active and relation = p_relation and p_operation = any (operations) order by name loop
    begin
      execute format('select (%s) from (select $1 as before, $2 as after) as change', rule.condition) into holds using p_before, p_after;
    exception when others then
      return format('%s (whose condition could not be worked out for this row): %s', rule.name, rule.reason);
    end;
    if holds is distinct from false then
      return format('%s: %s', rule.name, rule.reason);
    end if;
  end loop;
  return null;
end $$;

-- Writes a rule that forbids, or replaces one of the same name with the next version. For the tables' owner.
create function keyturn.forbid(name text, relation regclass, operations text[], condition text, reason text) returns void
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
#variable_conflict use_column
begin
  if not exists (select from keyturn.protected p where p.relation = forbid.relation) then
    raise exception 'keyturn: % is not a table under keyturn', forbid.relation;
  end if;
  if forbid.condition is null or forbid.reason is null then
    raise exception 'keyturn: a rule that forbids has a condition and a reason';
  end if;
  -- Tried once on an empty row, so that a condition that is not SQL is refused when it is written and not when it is needed.
  execute format('select (%s)::boolean from (select $1 as before, $2 as after) as change', forbid.condition) using '{}'::jsonb, '{}'::jsonb;
  insert into keyturn.forbidden (name, relation, operations, condition, reason)
    values (forbid.name, forbid.relation, forbid.operations, forbid.condition, forbid.reason)
    on conflict (name) do update
      set relation = excluded.relation, operations = excluded.operations, condition = excluded.condition, reason = excluded.reason,
          active = true, version = keyturn.forbidden.version + 1, written_by = session_user, written_at = clock_timestamp();
end $$;

-- ---------------------------------------------------------------- how a row is written down

-- A row is compared and hashed as JSON. JSON text depends on the session: a timestamp is
-- written in the session's time zone, a float with the session's digits. Every function
-- that reads or compares a row therefore runs with these settings, whatever the caller's are.
--
--   TimeZone UTC, DateStyle ISO, IntervalStyle iso_8601, extra_float_digits 3, bytea_output hex,
--   lc_monetary C

-- What a table looks like: its columns, in order, with their types. Two tables with the
-- same text here hold rows that can be compared.
create function keyturn.shape_of(p_relation regclass) returns text
  language sql stable
  set search_path = pg_catalog, pg_temp
  as $$
    select string_agg(attname || ' ' || format_type(atttypid, atttypmod) || case when attgenerated <> '' then ' generated' else '' end, ', ' order by attnum)
      from pg_attribute
     where attrelid = p_relation and attnum > 0 and not attisdropped
  $$;

-- A table's name with its schema, or null when the table is gone.
create function keyturn.name_of(p_relation regclass) returns text
  language sql stable
  set search_path = pg_catalog, pg_temp
  as $$
    select format('%I.%I', n.nspname, c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = p_relation
  $$;

-- Columns with their types, as a record definition: "id integer, total numeric(10,2)". JSON
-- is read into exactly these columns, each through its own type. A whole row of the table
-- is never built from part of one: a column that may not be null would refuse to be absent.
create function keyturn.columns_as(p_relation regclass, p_columns text[]) returns text
  language sql stable
  set search_path = pg_catalog, pg_temp
  as $$
    select string_agg(format('%I %s', attname, format_type(atttypid, atttypmod)), ', ' order by attnum)
      from pg_attribute
     where attrelid = p_relation and attnum > 0 and not attisdropped and attname = any (p_columns)
  $$;

-- The condition that picks out one row by its key, for a key given as JSON in $1.
--
-- Each key column is compared with the equality its primary key index uses. A type from an
-- extension keeps its own (a case-insensitive text stays case-insensitive), which the short
-- search path these functions run with would otherwise not find.
create function keyturn.key_condition(p_relation regclass, p_key_columns text[]) returns text
  language sql stable
  set search_path = pg_catalog, pg_temp
  as $$
    select string_agg(format('t.%1$I operator(%2$I.%3$s) (select k.%1$I from pg_catalog.jsonb_to_record($1) as k (%1$I %4$s))',
                             a.attname, n.nspname, o.oprname, format_type(a.atttypid, a.atttypmod)), ' and ' order by wanted.position)
      from unnest(p_key_columns) with ordinality as wanted (name, position)
      join pg_attribute a on a.attrelid = p_relation and a.attname = wanted.name and a.attnum > 0 and not a.attisdropped
      join pg_index i on i.indrelid = p_relation and i.indisprimary
      join lateral unnest(i.indkey::int2[], i.indclass::oid[]) as part (attnum, opclass) on part.attnum = a.attnum
      join pg_opclass c on c.oid = part.opclass
      join pg_amop m on m.amopfamily = c.opcfamily and m.amoplefttype = c.opcintype and m.amoprighttype = c.opcintype and m.amopstrategy = 3
      join pg_operator o on o.oid = m.amopopr
      join pg_namespace n on n.oid = o.oprnamespace
  $$;

-- A row of a table, written down: every column but the ones the table works out itself.
-- "t" is the row in the query this is put into.
create function keyturn.image(p_derived text[]) returns text
  language sql immutable
  set search_path = pg_catalog, pg_temp
  as $$ select format('(pg_catalog.to_jsonb(t) - %L::pg_catalog.text[])', p_derived) $$;

-- ---------------------------------------------------------------- protecting a table

-- Puts a table under Keyturn's care. The table must have a primary key: a proposal names
-- the rows it changes by it.
create function keyturn.protect(p_relation regclass, p_exact boolean default true) returns void
  language plpgsql
  set search_path = pg_catalog, pg_temp
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
-- One login may have so many proposals waiting and no more. Every waiting proposal is one a
-- person has to look at; without a limit, the party being reviewed could bury the ones that
-- matter, and fill the database with row images.
create function keyturn.room_for_another() returns void
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
begin
  if (select count(*) from keyturn.proposals where proposed_by = session_user and status = 'pending' and expires_at > clock_timestamp()) >= 200 then
    raise exception 'keyturn: % already has 200 proposals waiting for a decision. No more are taken until some are decided or expire', session_user;
  end if;
end $$;

create function keyturn.record_proposal(p_changes jsonb, p_note text, p_valid_for interval)
  returns table (proposal_id uuid, content_hash text)
  language plpgsql security definer
  set search_path = pg_catalog, pg_temp
  set timezone = 'UTC' set datestyle = 'ISO, YMD' set intervalstyle = 'iso_8601'
  set extra_float_digits = 3 set bytea_output = 'hex' set lc_monetary = 'C'
  -- Each change looks up the proposal's earlier ones. Every such lookup has an index, and
  -- this has the planner use it even while the table's statistics say it is empty.
  set enable_seqscan = off
  -- Compiling a query that reads one row costs many times what the query does.
  set jit = off
  as $$
<<given_>>
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
  forbidden text;
  -- Worked out once for a table and kept while the changes stay with it.
  kept_for  oid;
  reading   text;
  whole_row text;
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

  perform keyturn.room_for_another();

  -- The proposal's row comes first, so its changes can refer to it.
  insert into keyturn.proposals (id, proposed_by, note, expires_at)
    values (proposal, session_user, coalesce(p_note, ''), clock_timestamp() + p_valid_for);

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
    if target.shape is distinct from keyturn.shape_of(target.relation) then
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
                        where attrelid = target.relation and attname = name and attnum > 0 and not attisdropped and attgenerated = ''
                              -- A column the table always numbers itself takes no value from anyone.
                              and not (operation = 'insert' and attidentity = 'a'));
    if unknown is not null then
      raise exception 'keyturn: change %: % has no column "%" that can be set', seq, target.relation, unknown;
    end if;

    if not has_table_privilege(session_user, target.relation, 'SELECT') then
      raise exception 'keyturn: change %: % may not read %', seq, session_user, target.relation using errcode = 'insufficient_privilege';
    end if;

    if operation = 'insert' then
      before := null;
      -- Passed through the table's own types, so that 1 and "1" and 1.0 are written one way.
      execute format('select to_jsonb(r) from jsonb_to_record($1) as r (%s)', keyturn.columns_as(target.relation, columns)) into after using given;
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

      if kept_for is distinct from target.relation::oid then
        kept_for := target.relation::oid;
        reading := format('select %s from %s t where %s', keyturn.image(target.derived), target.relation, keyturn.key_condition(target.relation, target.key_columns));
        whole_row := format('select to_jsonb(t) from jsonb_to_record($1) as t (%s)', keyturn.columns_as(target.relation,
                       array(select attname::text from pg_attribute where attrelid = target.relation and attnum > 0 and not attisdropped and attname <> all (target.derived))));
      end if;
      execute reading into before using key;
      -- A proposal keeps the row it would change, and the proposer can read the proposal. So
      -- the proposer must already be able to read that row. propose() read it with the caller's
      -- own rights and handed it over as "seen"; it has to be the row that is really there.
      if before is null or change -> 'seen' is distinct from before then
        raise exception 'keyturn: change %: % has no row with key % that % can read', seq, target.relation, key, session_user;
      end if;
      key := (select jsonb_object_agg(entry.key, entry.value) from jsonb_each(before) as entry where entry.key = any (target.key_columns));

      if operation = 'update' then
        execute whole_row into after using before || given;
        if after = before then
          raise exception 'keyturn: change %: the row already has these values', seq;
        end if;
      else
        after := null;
      end if;
    end if;

    -- One change to a row in one proposal. A second would be approved against a row the first has already altered.
    if key <> '{}'::jsonb and exists (select from keyturn.changes c where c.proposal_id = proposal and c.relation = target.relation and c.key = given_.key and c.key <> '{}'::jsonb) then
      raise exception 'keyturn: change %: the row % of % already has a change in this proposal', seq, key, target.relation;
    end if;

    forbidden := keyturn.forbidden_by(target.relation, operation, before, after);
    if forbidden is not null then
      raise exception 'keyturn: change %: forbidden by the rule %. Nothing is recorded', seq, forbidden using errcode = 'insufficient_privilege';
    end if;

    insert into keyturn.changes (proposal_id, seq, relation, relation_name, shape, operation, key, before, after, columns)
      values (proposal, seq, target.relation, keyturn.name_of(target.relation), target.shape, operation, key, before, after, columns);
  end loop;

  perform keyturn.audit_append(proposal, 'opened', jsonb_build_object('changes', seq));
  return query select proposal, keyturn.hash_of(proposal);
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
  set extra_float_digits = 3 set bytea_output = 'hex' set lc_monetary = 'C'
  as $$
-- No search path is set here, on purpose: the caller's own decides which table a bare name
-- means. So every type below is written with its schema, and nothing here runs with more
-- than the caller's rights.
declare
  change   pg_catalog.jsonb;
  position pg_catalog.int8;
  target   keyturn.protected;
  seen     pg_catalog.jsonb;
  -- An array, added to in place. A jsonb list joined to itself row by row is copied whole each time.
  named    pg_catalog.jsonb[] := '{}';
  -- The query that reads one row of a table, kept while the changes stay with that table.
  reading  pg_catalog.text;
  read_of  pg_catalog.oid;
begin
  if jsonb_typeof(p_changes) is distinct from 'array' then
    return query select * from keyturn.record_proposal(p_changes, p_note, p_valid_for);
    return;
  end if;

  for change, position in select listed.change, listed.position from jsonb_array_elements(p_changes) with ordinality as listed (change, position) loop
    if jsonb_typeof(change) = 'object' and to_regclass(change ->> 'table') is not null then
      select * into target from keyturn.protected where relation = to_regclass(change ->> 'table');
      change := (change - 'seen') || jsonb_build_object('table', to_regclass(change ->> 'table')::pg_catalog.oid::pg_catalog.text);
      if target.relation is not null and change ->> 'operation' in ('update', 'delete') and jsonb_typeof(change -> 'key') = 'object' then
        if read_of is distinct from target.relation::pg_catalog.oid then
          read_of := target.relation::pg_catalog.oid;
          reading := format('select %s from %s t where %s', keyturn.image(target.derived), target.relation, keyturn.key_condition(target.relation, target.key_columns));
        end if;
        begin
          execute reading into seen using change -> 'key';
        exception when insufficient_privilege then
          seen := null;
        end;
        change := change || jsonb_build_object('seen', seen);
      end if;
    end if;
    named := array_append(named, change);
  end loop;
  return query select * from keyturn.record_proposal(to_jsonb(named), p_note, p_valid_for);
end $$;

-- The hash of a proposal's content: every change, in order, with the note. jsonb writes its
-- keys in one order and its numbers one way, so the same content always gives the same text.
create function keyturn.hash_of(p_proposal_id uuid) returns text
  language sql stable
  set search_path = pg_catalog, pg_temp
  as $$
    select encode(sha256(convert_to(jsonb_build_object(
             'note', (select note from keyturn.proposals where id = p_proposal_id),
             'changes', jsonb_agg(jsonb_build_object(
               'table', relation_name, 'shape', shape, 'operation', operation,
               'key', key, 'before', before, 'after', after, 'columns', columns) order by seq))::text, 'UTF8')), 'hex')
      from keyturn.changes
     where proposal_id = p_proposal_id
  $$;

-- ---------------------------------------------------------------- deciding

-- Whether the login on this connection is in a group. The login is what counts: a function
-- that runs with its owner's rights still sees who connected.
create function keyturn.caller_is(p_group name) returns boolean
  language sql stable
  set search_path = pg_catalog, pg_temp
  as $$ select pg_has_role(session_user, p_group, 'MEMBER') $$;

-- The first change of a proposal that a rule forbids, with the rule's name and reason, or null.
create function keyturn.forbidden_in(p_proposal_id uuid) returns text
  language plpgsql stable
  set search_path = pg_catalog, pg_temp
  as $$
declare
  change    keyturn.changes;
  forbidden text;
begin
  -- Most tables have no such rule, and a proposal may hold ten thousand changes.
  if not exists (select from keyturn.forbidden f where f.active and f.relation in (select c.relation from keyturn.changes c where c.proposal_id = p_proposal_id)) then
    return null;
  end if;
  for change in select * from keyturn.changes where proposal_id = p_proposal_id order by seq loop
    forbidden := keyturn.forbidden_by(change.relation, change.operation, change.before, change.after);
    if forbidden is not null then
      return format('change %s is forbidden by the rule %s', change.seq, forbidden);
    end if;
  end loop;
  return null;
end $$;

-- Approves a proposal. The approver says which content they are approving, by its hash. If
-- that is not what the proposal holds, nothing is approved.
create function keyturn.approve(p_proposal_id uuid, p_content_hash text) returns void
  language plpgsql security definer
  set search_path = pg_catalog, pg_temp
  as $$
declare
  proposal  keyturn.proposals;
  forbidden text;
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
  -- Held against what the proposal holds at this moment. From here on that hash is the proposal's.
  if p_content_hash is distinct from keyturn.hash_of(p_proposal_id) then
    raise exception 'keyturn: that is not the content of this proposal';
  end if;
  -- A change a rule forbids is not approved by anyone. It was held against the rules when it
  -- was proposed; a rule written since, or a record changed since, is seen here.
  forbidden := keyturn.forbidden_in(p_proposal_id);
  if forbidden is not null then
    raise exception 'keyturn: no one may approve this: %', forbidden using errcode = 'insufficient_privilege';
  end if;
  update keyturn.proposals set status = 'approved', content_hash = p_content_hash, decided_by = session_user, decided_at = clock_timestamp()
   where id = p_proposal_id;
  perform keyturn.audit_append(p_proposal_id, 'approved', jsonb_build_object('content_hash', p_content_hash));
end $$;

create function keyturn.reject(p_proposal_id uuid, p_reason text default null) returns void
  language plpgsql security definer
  set search_path = pg_catalog, pg_temp
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
  perform keyturn.audit_append(p_proposal_id, 'rejected', jsonb_strip_nulls(jsonb_build_object('reason', p_reason)));
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
  set search_path = pg_catalog, pg_temp
  set timezone = 'UTC' set datestyle = 'ISO, YMD' set intervalstyle = 'iso_8601'
  set extra_float_digits = 3 set bytea_output = 'hex' set lc_monetary = 'C'
  -- Each change is a query for one row. Compiling those costs many times what they do.
  set jit = off
  as $$
declare
  proposal keyturn.proposals;
  change   keyturn.changes;
  target   keyturn.protected;
  locate   text;
  located  oid;
  current_ jsonb;
  written  jsonb;
  touched  bigint;
  result   jsonb;
  covered  jsonb;
  rule     keyturn.rules;
  forbidden text;
begin
  if not (keyturn.caller_is('keyturn_agent') or keyturn.caller_is('keyturn_approver')) then
    raise exception 'keyturn: % may not use keyturn', session_user using errcode = 'insufficient_privilege';
  end if;

  -- One caller at a time holds the proposal. A second waits here, then sees what the first did.
  select * into proposal from keyturn.proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'keyturn: no such proposal';
  end if;
  if proposal.status in ('applied', 'stale', 'failed', 'reverted') then
    return proposal.outcome;
  end if;
  if proposal.expires_at <= clock_timestamp() then
    raise exception 'keyturn: the proposal expired at %', proposal.expires_at;
  end if;
  -- A change a rule forbids is not written, whoever approved it and whenever. The rules for
  -- these tables are held first and read after, as the rules below are, so that two proposals
  -- held against one running total are taken one after the other.
  perform from keyturn.forbidden f
    where f.active and f.relation in (select c.relation from keyturn.changes c where c.proposal_id = p_proposal_id)
    order by f.name for update;
  if found then
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'keyturn: a table with a rule that forbids is written only in a read committed transaction; this one is %', current_setting('transaction_isolation')
        using errcode = 'insufficient_privilege';
    end if;
    forbidden := keyturn.forbidden_in(p_proposal_id);
    if forbidden is not null then
      raise exception 'keyturn: nothing is written: %', forbidden using errcode = 'insufficient_privilege';
    end if;
  end if;
  -- Nobody has decided. If the owner's rules cover every change in it, they decide, and it is on record that they did.
  if proposal.status = 'pending' then
    -- The rules for these tables are held first and read after, so that a rule switched off or
    -- rewritten meanwhile is seen as it now is, and two proposals under one rule are counted
    -- one after the other.
    perform from keyturn.rules r
      where r.relation in (select c.relation from keyturn.changes c where c.proposal_id = p_proposal_id)
      order by r.name for update;
    covered := keyturn.rules_covering(p_proposal_id);
    if covered is not null and current_setting('transaction_isolation') <> 'read committed' then
      -- A transaction that keeps one view of the data for its whole length cannot see what a
      -- rule let through after it began, and would count short.
      raise exception 'keyturn: a rule decides only in a read committed transaction; this one is %', current_setting('transaction_isolation')
        using errcode = 'insufficient_privilege';
    end if;
    for rule in select r.* from keyturn.rules r where covered ? r.name order by r.name loop
      select count(*) into touched from keyturn.audit
       where event = 'approved_by_rule' and at > clock_timestamp() - interval '1 hour' and detail -> 'rules' ? rule.name;
      if touched >= rule.per_hour then
        raise exception 'keyturn: the rule % has let % proposals through in the last hour, which is all it may; this one waits for a person', rule.name, touched
          using errcode = 'insufficient_privilege';
      end if;
    end loop;
    if covered is not null then
      update keyturn.proposals set status = 'approved', content_hash = keyturn.hash_of(p_proposal_id), decided_by = 'keyturn_rule', decided_at = clock_timestamp()
       where id = p_proposal_id returning * into proposal;
      perform keyturn.audit_append(p_proposal_id, 'approved_by_rule', jsonb_build_object('rules', covered, 'content_hash', proposal.content_hash));
    end if;
  end if;
  if proposal.status <> 'approved' then
    raise exception 'keyturn: the proposal is %, not approved', proposal.status using errcode = 'insufficient_privilege';
  end if;
  if proposal.content_hash is distinct from keyturn.hash_of(p_proposal_id) then
    raise exception 'keyturn: the proposal is not what was approved';
  end if;

  -- First pass: every row the proposal touches is locked and held against what was recorded.
  -- Nothing is written until all of them match.
  --
  -- Rows are locked in one order whatever order the proposal lists them in, so that two
  -- proposals touching the same rows cannot each hold what the other waits for.
  for change in select * from keyturn.changes where proposal_id = p_proposal_id order by relation, key, seq loop
    select * into target from keyturn.protected where relation = change.relation;
    if keyturn.name_of(change.relation) is null then
      result := jsonb_build_object('status', 'stale', 'change', change.seq, 'reason', format('%s no longer exists', change.relation_name));
      exit;
    end if;
    if keyturn.name_of(change.relation) <> change.relation_name then
      result := jsonb_build_object('status', 'stale', 'change', change.seq,
        'reason', format('%s has been renamed to %s since the proposal was made', change.relation_name, keyturn.name_of(change.relation)));
      exit;
    end if;
    if target.relation is null then
      result := jsonb_build_object('status', 'stale', 'change', change.seq, 'reason', format('%s is no longer under keyturn', change.relation_name));
      exit;
    end if;
    if change.shape is distinct from keyturn.shape_of(change.relation) then
      result := jsonb_build_object('status', 'stale', 'change', change.seq, 'reason', format('%s has changed shape since the proposal was made', change.relation));
      exit;
    end if;
    if located is distinct from change.relation::oid then
      located := change.relation::oid;
      locate := keyturn.key_condition(change.relation, target.key_columns);
    end if;
    -- An update leaves the key alone, so it takes the lock that lets rows that refer to this one still be added.
    execute format('select %s from %s t where %s for %s', keyturn.image(target.derived), change.relation, locate,
                   case change.operation when 'update' then 'no key update' else 'update' end) into current_ using change.key;
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
    perform keyturn.audit_append(p_proposal_id, 'stale', result);
    return result;
  end if;

  -- Second pass: the writes. If one of them fails, or a row does not come out as approved,
  -- everything written here is undone and the proposal is marked failed.
  begin
    for change in select * from keyturn.changes where proposal_id = p_proposal_id order by seq loop
      select * into target from keyturn.protected where relation = change.relation;
      if located is distinct from change.relation::oid then
        located := change.relation::oid;
        locate := keyturn.key_condition(change.relation, target.key_columns);
      end if;
      -- Each write hands back the row as it was written, which is what gets held against the approval.
      written := null;
      if change.operation = 'insert' then
        execute format('insert into %1$s as t (%2$s) select %2$s from jsonb_to_record($1) as given (%4$s) returning %3$s',
          change.relation, (select string_agg(format('%I', name), ', ') from unnest(change.columns) as name), keyturn.image(target.derived),
          keyturn.columns_as(change.relation, change.columns)) into written using change.after;
      elsif change.operation = 'update' then
        -- The row set is one column wide or many; "row" makes the two cases read alike.
        execute format('update %1$s t set (%2$s) = (select %2$s from jsonb_to_record($2) as given (%5$s)) where %3$s returning %4$s',
          change.relation, (select string_agg(format('%I', name), ', ') from unnest(change.columns) as name), locate, keyturn.image(target.derived),
          keyturn.columns_as(change.relation, change.columns)) into written using change.key, change.after;
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
      if written is distinct from change.after then
        update keyturn.changes c set as_written = written where c.proposal_id = p_proposal_id and c.seq = change.seq;
      end if;
    end loop;
  exception when others then
    -- A lock not got in time, a deadlock, a server short of something: none of these says
    -- anything about the change. They are passed on, the proposal stays approved, and the
    -- caller tries again. Only a write the table itself turned down ends the proposal.
    if left(sqlstate, 2) in ('08', '40', '53', '55', '57', '58', 'XX') then
      raise;
    end if;
    result := jsonb_build_object('status', 'failed', 'reason', sqlerrm);
    update keyturn.proposals set status = 'failed', outcome = result, finished_at = clock_timestamp() where id = p_proposal_id;
    perform keyturn.audit_append(p_proposal_id, 'failed', result);
    return result;
  end;

  result := jsonb_build_object('status', 'applied', 'changes', (select count(*) from keyturn.changes where proposal_id = p_proposal_id));
  update keyturn.proposals set status = 'applied', outcome = result, finished_at = clock_timestamp() where id = p_proposal_id;
  perform keyturn.audit_append(p_proposal_id, 'applied', result);
  return result;
end $$;

-- Checks the audit log. Gives a row for each thing that does not fit: an entry whose hash is
-- not the hash of what it says, an entry that does not follow the one before it, or a
-- proposal whose last entry is not where the proposal now stands.
create function keyturn.verify_audit() returns table (proposal_id uuid, problem text)
  language plpgsql stable
  set search_path = pg_catalog, pg_temp
  as $$
declare
  entry    keyturn.audit;
  previous text;
  current_ uuid;
begin
  for entry in select * from keyturn.audit order by audit.proposal_id, seq loop
    if current_ is distinct from entry.proposal_id then
      current_ := entry.proposal_id;
      previous := '';
    end if;
    if entry.prev_hash <> previous then
      return query select entry.proposal_id, format('entry %s does not follow the entry before it', entry.seq);
    elsif entry.hash <> keyturn.audit_hash(entry.prev_hash, entry.proposal_id, entry.at, entry.actor, entry.event, entry.detail) then
      return query select entry.proposal_id, format('entry %s has been changed', entry.seq);
    end if;
    previous := entry.hash;
  end loop;

  return query
    select p.id, format('the proposal is %s and its last entry says %s', p.status, coalesce(last.event, 'nothing'))
      from keyturn.proposals p
      left join lateral (select event from keyturn.audit a where a.proposal_id = p.id order by seq desc limit 1) last on true
     where coalesce(last.event, '') <> case p.status when 'pending' then 'opened' when 'approved' then last.event else p.status end
        or (p.status = 'approved' and coalesce(last.event, '') not in ('approved', 'approved_by_rule'));
end $$;

-- One value for the whole log as it stands. Kept somewhere the database's owner cannot
-- reach, it shows later whether entries were rewritten or removed by someone who could
-- switch the log's own guards off.
create function keyturn.audit_head() returns table (entries bigint, head text)
  language sql stable
  set search_path = pg_catalog, pg_temp
  as $$
    select count(*), encode(sha256(convert_to(coalesce(string_agg(hash, '' order by seq), ''), 'UTF8')), 'hex') from keyturn.audit
  $$;

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

-- The list of protected tables holds each one's columns and types. An agent sees the
-- entries for tables it may read, and learns nothing here about the others.
alter table keyturn.protected enable row level security;
create policy readable on keyturn.protected for select
  using (pg_has_role(session_user, 'keyturn_approver', 'MEMBER') or has_table_privilege(session_user, relation, 'SELECT'));

-- The audit log is read the way proposals are: an agent its own, an approver all of it.
alter table keyturn.audit enable row level security;
create policy own_or_approver on keyturn.audit for select
  using (pg_has_role(session_user, 'keyturn_approver', 'MEMBER')
         or exists (select from keyturn.proposals where proposals.id = audit.proposal_id and proposals.proposed_by = session_user));

-- ---------------------------------------------------------------- who may do what

revoke all on schema keyturn from public;
revoke all on all tables in schema keyturn from public;
revoke all on all functions in schema keyturn from public;

grant usage on schema keyturn to keyturn_agent, keyturn_approver;
-- Both may read proposals and their changes. Neither may write them: only the functions do.
grant select on keyturn.proposals, keyturn.changes, keyturn.protected, keyturn.audit to keyturn_agent, keyturn_approver;
-- An approver may read the rules: they decide what never reaches an approver.
grant select on keyturn.rules, keyturn.forbidden to keyturn_approver;
grant execute on function keyturn.propose(jsonb, text, interval), keyturn.record_proposal(jsonb, text, interval) to keyturn_agent;
grant execute on function keyturn.apply(uuid) to keyturn_agent, keyturn_approver;
grant execute on function keyturn.approve(uuid, text), keyturn.reject(uuid, text) to keyturn_approver;
grant execute on function keyturn.verify_audit(), keyturn.audit_head(), keyturn.audit_hash(text, uuid, timestamptz, name, text, jsonb) to keyturn_approver;
grant execute on function keyturn.hash_of(uuid), keyturn.caller_is(name), keyturn.shape_of(regclass), keyturn.key_condition(regclass, text[]), keyturn.image(text[]) to keyturn_agent, keyturn_approver;
