-- Keyturn: taking an applied change back.
--
-- A proposal holds every row as it was before. So what was written can be put back exactly:
-- an inserted row is deleted, an updated row gets its old values in the columns that were
-- set, a deleted row is inserted again as it was.
--
-- It is done by an approver, the login a person uses, and never by an agent. Like the
-- change itself it is all or nothing, and it is held against the rows as they are: if one
-- of them is no longer as the proposal left it, somebody has written there since, and
-- nothing is taken back.
--
-- It puts back the rows of the protected tables and nothing else. What a trigger or a
-- cascade did elsewhere when the change was applied is not undone here.

-- Takes back an applied proposal. Returns what became of it: reverted, with the number of
-- changes taken back, or conflict, with the first row that stood in the way.
create function keyturn.revert(p_proposal_id uuid, p_reason text default null) returns jsonb
  language plpgsql security definer
  set search_path = pg_catalog, pg_temp
  set timezone = 'UTC' set datestyle = 'ISO, YMD' set intervalstyle = 'iso_8601'
  set extra_float_digits = 3 set bytea_output = 'hex' set lc_monetary = 'C'
  set jit = off
  as $$
declare
  proposal  keyturn.proposals;
  change    keyturn.changes;
  target    keyturn.protected;
  locate    text;
  row_key   jsonb;
  left_as   jsonb;
  current_  jsonb;
  put_back  jsonb;
  touched   bigint;
  result    jsonb;
  forbidden text;
  names     text;
  guarded   boolean;
begin
  if not keyturn.caller_is('keyturn_approver') then
    raise exception 'keyturn: % is not an approver', session_user using errcode = 'insufficient_privilege';
  end if;
  if p_reason is not null and length(p_reason) > 2000 then
    raise exception 'keyturn: a reason is at most 2000 characters';
  end if;
  select * into proposal from keyturn.proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'keyturn: no such proposal';
  end if;
  if proposal.status = 'reverted' then
    return proposal.outcome;
  end if;
  if proposal.status <> 'applied' then
    raise exception 'keyturn: the proposal is %, not applied: there is nothing to take back', proposal.status;
  end if;

  -- A transaction that keeps one view of the data cannot see a rule written after it began.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'keyturn: a change is taken back only in a read committed transaction; this one is %', current_setting('transaction_isolation')
      using errcode = 'insufficient_privilege';
  end if;
  -- Taking a change back is a write like any other, and a rule that forbids holds for it.
  guarded := keyturn.hold_forbidden(p_proposal_id);
  if guarded then
    for change in select * from keyturn.changes where proposal_id = p_proposal_id order by seq loop
      left_as := coalesce(change.as_written, change.after);
      forbidden := case change.operation
        when 'insert' then keyturn.forbidden_by(change.relation, 'delete', left_as, null)
        when 'update' then keyturn.forbidden_by(change.relation, 'update', left_as, change.before)
        else keyturn.forbidden_by(change.relation, 'insert', null, change.before) end;
      if forbidden is not null then
        raise exception 'keyturn: nothing is taken back: undoing change % is forbidden by the rule %', change.seq, forbidden
          using errcode = 'insufficient_privilege';
      end if;
    end loop;
  end if;

  -- First pass: every row is locked and held against what the proposal left there.
  for change in select * from keyturn.changes where proposal_id = p_proposal_id order by relation, key, seq loop
    select * into target from keyturn.protected where relation = change.relation;
    if keyturn.name_of(change.relation) is null then
      result := jsonb_build_object('status', 'conflict', 'change', change.seq, 'reason', format('%s no longer exists', change.relation_name));
      exit;
    end if;
    if target.relation is null then
      result := jsonb_build_object('status', 'conflict', 'change', change.seq, 'reason', format('%s is no longer under keyturn', change.relation_name));
      exit;
    end if;
    if change.shape is distinct from keyturn.shape_of(change.relation) then
      result := jsonb_build_object('status', 'conflict', 'change', change.seq, 'reason', format('%s has changed shape since the change was applied', change.relation_name));
      exit;
    end if;
    left_as := coalesce(change.as_written, change.after);
    -- An insert that left its key to the table has it in the row as written.
    row_key := case when change.key ?& target.key_columns then change.key
                else (select jsonb_object_agg(part.key, part.value) from jsonb_each(left_as) as part where part.key = any (target.key_columns)) end;
    if row_key is null or not (row_key ?& target.key_columns) then
      result := jsonb_build_object('status', 'conflict', 'change', change.seq, 'reason', format('the row written to %s was not recorded, so it cannot be found again', change.relation_name));
      exit;
    end if;
    locate := keyturn.key_condition(change.relation, target.key_columns);
    execute format('select %s from %s t where %s for update', keyturn.image(target.derived), change.relation, locate) into current_ using row_key;
    if change.operation = 'delete' then
      if current_ is not null then
        result := jsonb_build_object('status', 'conflict', 'change', change.seq, 'reason', format('%s has a row with key %s again', change.relation_name, row_key));
        exit;
      end if;
    elsif current_ is null then
      result := jsonb_build_object('status', 'conflict', 'change', change.seq, 'reason', format('the row %s of %s is gone', row_key, change.relation_name));
      exit;
    -- Equal, not "contains": a list somebody has added to since is their work.
    elsif current_ is distinct from left_as then
      result := jsonb_build_object('status', 'conflict', 'change', change.seq, 'reason', format('the row %s of %s has changed since the change was applied', row_key, change.relation_name));
      exit;
    end if;
  end loop;
  if result is not null then
    return result;
  end if;

  -- Second pass: the writes, last change first. Anything that goes wrong here stops the
  -- whole of it with an error, and nothing is taken back.
  for change in select * from keyturn.changes where proposal_id = p_proposal_id order by seq desc loop
    select * into target from keyturn.protected where relation = change.relation;
    left_as := coalesce(change.as_written, change.after);
    row_key := case when change.key ?& target.key_columns then change.key
                else (select jsonb_object_agg(part.key, part.value) from jsonb_each(left_as) as part where part.key = any (target.key_columns)) end;
    locate := keyturn.key_condition(change.relation, target.key_columns);
    -- Held against the rules again with the later changes already taken back: two rows that
    -- may each be removed alone must also be allowed to go together.
    if guarded then
      forbidden := case change.operation
        when 'insert' then keyturn.forbidden_by(change.relation, 'delete', left_as, null)
        when 'update' then keyturn.forbidden_by(change.relation, 'update', left_as, change.before)
        else keyturn.forbidden_by(change.relation, 'insert', null, change.before) end;
      if forbidden is not null then
        raise exception 'keyturn: nothing is taken back: undoing change % is forbidden by the rule %', change.seq, forbidden
          using errcode = 'insufficient_privilege';
      end if;
    end if;
    put_back := null;
    if change.operation = 'insert' then
      execute format('delete from %s t where %s', change.relation, locate) using row_key;
    elsif change.operation = 'update' then
      names := (select string_agg(format('%I', name), ', ') from unnest(change.columns) as name);
      execute format('update %1$s t set (%2$s) = (select %2$s from jsonb_to_record($2) as given (%5$s)) where %3$s returning %4$s',
        change.relation, names, locate, keyturn.image(target.derived), keyturn.columns_as(change.relation, change.columns))
        into put_back using row_key, change.before;
    else
      -- Every column the row had, its key and the values the table once made for it among them.
      names := (select string_agg(format('%I', part.key), ', ') from jsonb_each(change.before) as part);
      execute format('insert into %1$s as t (%2$s) overriding system value select %2$s from jsonb_to_record($1) as given (%4$s) returning %3$s',
        change.relation, names, keyturn.image(target.derived),
        keyturn.columns_as(change.relation, (select array_agg(part.key) from jsonb_each(change.before) as part)))
        into put_back using change.before;
    end if;
    get diagnostics touched = row_count;
    if touched <> 1 then
      raise exception 'keyturn: undoing change % touched % rows, not 1', change.seq, touched;
    end if;
    -- A trigger on the table may have written something other than the row as it was.
    if target.exact and change.operation <> 'insert' and put_back is distinct from change.before then
      raise exception 'keyturn: undoing change %: the row did not come out as it was before', change.seq;
    end if;
  end loop;

  result := jsonb_strip_nulls(jsonb_build_object('status', 'reverted', 'reason', p_reason,
              'changes', (select count(*) from keyturn.changes where proposal_id = p_proposal_id)));
  update keyturn.proposals set status = 'reverted', outcome = result, finished_at = clock_timestamp() where id = p_proposal_id;
  perform keyturn.audit_append(p_proposal_id, 'reverted', result);
  return result;
end $$;

revoke all on function keyturn.revert(uuid, text) from public;
grant execute on function keyturn.revert(uuid, text) to keyturn_approver;
