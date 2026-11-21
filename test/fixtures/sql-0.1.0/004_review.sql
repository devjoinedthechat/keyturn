-- Keyturn: what a reviewer reads.
--
-- An approver decides on rows, so the rows have to reach them exactly as the database holds
-- them. Values are given as text here, written by PostgreSQL: a number passed through a
-- program's own number type on the way to the screen can lose digits, and a reviewer would
-- then approve a figure that is not the one applied.

-- One row for each column of each row a proposal would change, in the table's column order.
--
-- "before_kind" and "after_kind" say what the value is: string, number, boolean, null, array
-- or object, or absent when the row does not exist on that side (an insert has no before, a
-- delete no after) or the column was not given.
create function keyturn.diff(p_proposal_id uuid, p_from integer default 1, p_count integer default 100)
  returns table (seq integer, relation text, operation text, key jsonb, column_name text,
                 before text, after text, before_kind text, after_kind text, changed boolean)
  language sql stable
  set search_path = pg_catalog, pg_temp
  as $$
    select c.seq, c.relation_name, c.operation, c.key, col.name,
           (c.before -> col.name) #>> '{}', (c.after -> col.name) #>> '{}',
           coalesce(jsonb_typeof(c.before -> col.name), 'absent'), coalesce(jsonb_typeof(c.after -> col.name), 'absent'),
           (c.before -> col.name) is distinct from (c.after -> col.name)
      from keyturn.changes c
      cross join lateral jsonb_object_keys(coalesce(c.before, '{}') || coalesce(c.after, '{}')) as col (name)
      left join pg_attribute a on a.attrelid = c.relation and a.attname = col.name and a.attnum > 0
     where c.proposal_id = p_proposal_id and c.seq >= p_from and c.seq < p_from::bigint + least(greatest(p_count, 0), 1000)
     order by c.seq, a.attnum nulls last, col.name
  $$;

-- How much a proposal would change, by table and operation. The first thing to read: forty
-- thousand deletes should not look like one.
create function keyturn.extent(p_proposal_id uuid)
  returns table (relation text, operation text, row_count bigint)
  language sql stable
  set search_path = pg_catalog, pg_temp
  as $$
    select c.relation_name, c.operation, count(*)
      from keyturn.changes c
     where c.proposal_id = p_proposal_id
     group by 1, 2
     order by 1, 2
  $$;

revoke all on function keyturn.diff(uuid, integer, integer), keyturn.extent(uuid) from public;
grant execute on function keyturn.diff(uuid, integer, integer), keyturn.extent(uuid) to keyturn_agent, keyturn_approver;
