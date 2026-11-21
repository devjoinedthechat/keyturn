-- Keyturn: putting old records away.
--
-- Nothing in the audit log is ever changed, and the log would otherwise only grow. The owner
-- may take whole proposals that are finished out of the database, once they have been
-- written to a file outside it. What is taken out is exactly what the file holds: the owner
-- names the digest of what was written, and nothing is removed if that is not the digest of
-- what would be removed. A mark stays behind saying when, by whom, how much, and what the
-- value of the whole log was before and after.
--
-- A proposal is finished when it was rejected, applied, taken back, found stale or failed,
-- or was never decided and has expired. Its entries go with it, all of them, so every chain
-- of entries left in the log is whole.

create table keyturn.archived (
  seq         bigint      generated always as identity primary key,
  at          timestamptz not null default clock_timestamp(),
  by          name        not null default session_user,
  -- Every finished proposal whose last entry was before this was taken out.
  before      timestamptz not null,
  proposals   bigint      not null,
  entries     bigint      not null,
  -- The digest of the entries taken out, which is also at the head of the file they were written to.
  digest      text        not null,
  -- The hash of the file itself, as the one who wrote it gave it. With this kept, a file
  -- that has been altered since can be told from the one that was written.
  file        text,
  head_before text        not null,
  head_after  text        not null
);

-- The proposals that may be taken out: finished, with nothing said of them since the given time.
create function keyturn.archivable(p_before timestamptz) returns setof uuid
  language sql stable
  set search_path = pg_catalog, pg_temp
  as $$
    select p.id
      from keyturn.proposals p
     where (p.status in ('rejected', 'applied', 'stale', 'failed', 'reverted')
            or (p.status in ('pending', 'approved') and p.expires_at < p_before))
       and not exists (select from keyturn.audit a where a.proposal_id = p.id and a.at >= p_before)
       and p.proposed_at < p_before
  $$;

-- How much that is, and its digest: the hash of every entry's own hash, in the log's order.
create function keyturn.archive_digest(p_before timestamptz)
  returns table (proposals bigint, entries bigint, digest text)
  language sql stable
  set search_path = pg_catalog, pg_temp
  as $$
    select (select count(*) from keyturn.archivable(p_before)),
           count(*),
           encode(sha256(convert_to(coalesce(string_agg(a.hash, '' order by a.seq), ''), 'UTF8')), 'hex')
      from keyturn.audit a
     where a.proposal_id in (select keyturn.archivable(p_before))
  $$;

-- The audit log's guard, with the one way past it: a removal by keyturn.prune, which says so
-- for the length of its own transaction. An update is never let through, and nor is emptying.
create or replace function keyturn.refuse_change() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' and current_setting('keyturn.pruning', true) = 'on' then
    return old;
  end if;
  raise exception 'keyturn: the audit log is never changed or emptied';
end $$;

-- Takes out every finished proposal from before the given time, with its changes and its
-- entries. For the owner, who gives the digest of what was written to the file: if what would
-- be removed has any other digest, nothing is removed.
create function keyturn.prune(p_before timestamptz, p_digest text, p_file text default null) returns jsonb
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $$
declare
  found   record;
  head_   text;
  after_  text;
  gone    uuid[];
  result  jsonb;
begin
  if p_before is null or p_before > clock_timestamp() then
    raise exception 'keyturn: records are put away up to a time that has passed';
  end if;
  -- Nothing is proposed, decided or applied while this looks and removes.
  lock table keyturn.proposals, keyturn.audit in share row exclusive mode;
  select * into found from keyturn.archive_digest(p_before);
  if found.digest is distinct from p_digest then
    raise exception 'keyturn: that is not the digest of what would be removed. Nothing is removed. Write the file again and give its digest';
  end if;
  select head into head_ from keyturn.audit_head();
  gone := array(select keyturn.archivable(p_before));

  perform set_config('keyturn.pruning', 'on', true);
  delete from keyturn.audit where proposal_id = any (gone);
  perform set_config('keyturn.pruning', 'off', true);
  delete from keyturn.changes where proposal_id = any (gone);
  delete from keyturn.proposals where id = any (gone);

  select head into after_ from keyturn.audit_head();
  insert into keyturn.archived (before, proposals, entries, digest, file, head_before, head_after)
    values (p_before, found.proposals, found.entries, found.digest, p_file, head_, after_);
  result := jsonb_build_object('proposals', found.proposals, 'entries', found.entries, 'digest', found.digest,
                               'head_before', head_, 'head_after', after_);
  return result;
end $$;

revoke all on keyturn.archived from public;
revoke all on function keyturn.archivable(timestamptz), keyturn.archive_digest(timestamptz), keyturn.prune(timestamptz, text, text) from public;
-- An approver may read the marks, and may work out what would be put away. Only the owner removes.
grant select on keyturn.archived to keyturn_approver;
grant execute on function keyturn.archivable(timestamptz), keyturn.archive_digest(timestamptz) to keyturn_approver;
