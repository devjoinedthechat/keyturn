-- Keyturn, doctor.
--
-- Keyturn's claim is only as true as the database it is installed in. A role that owns the
-- table, or was granted a write on it some other way, is not held by anything here. This
-- function looks at the database as it is and says where the claim does not hold.
--
-- Run it as the tables' owner or as an administrator: select * from keyturn.doctor();
--
--   fail   the claim does not hold until this is fixed
--   note   the claim holds; this is something to know

create function keyturn.doctor()
  returns table (level text, about text, finding text, fix text)
  language plpgsql
  set search_path = pg_catalog
  as $$
declare
  member    record;
  target    record;
  writer    record;
  privilege text;
begin
  -- Every role that acts as an agent: the group itself and every role that is in it, directly or not.
  for member in
    -- Membership as it is granted, followed through groups. pg_has_role would also say yes for
    -- every superuser, who is a member of nothing and is not an agent.
    with recursive agents (oid) as (
      select oid from pg_roles where rolname = 'keyturn_agent'
      union
      select pg_auth_members.member from pg_auth_members join agents on agents.oid = pg_auth_members.roleid
    )
    select rolname, rolsuper, rolbypassrls, rolcreaterole, pg_roles.oid
      from pg_roles join agents using (oid)
     order by rolname
  loop
    if member.rolsuper then
      return query select 'fail', member.rolname::text, 'is a superuser, and a superuser can write anything', format('alter role %I nosuperuser', member.rolname);
    end if;
    if member.rolbypassrls then
      return query select 'fail', member.rolname::text, 'bypasses row-level security, so it can propose changes to rows it should not see', format('alter role %I nobypassrls', member.rolname);
    end if;
    if member.rolcreaterole then
      return query select 'fail', member.rolname::text, 'can create and alter roles, which is a way to a role that can write', format('alter role %I nocreaterole', member.rolname);
    end if;
    if member.rolname <> 'keyturn_agent' and pg_has_role(member.oid, 'keyturn_approver', 'MEMBER') then
      return query select 'fail', member.rolname::text, 'is both an agent and an approver', format('revoke keyturn_approver from %I', member.rolname);
    end if;

    for target in select relation, relation::text as name, (select relowner from pg_class where oid = relation) as owner from keyturn.protected order by 2 loop
      if pg_has_role(member.oid, target.owner, 'MEMBER') then
        return query select 'fail', member.rolname::text, format('owns %s, or is a member of the role that does', target.name),
          format('give %s an owner the agent is not a member of', target.name);
        continue;
      end if;
      foreach privilege in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
        if has_table_privilege(member.oid, target.relation, privilege) then
          return query select 'fail', member.rolname::text, format('may %s %s', lower(privilege), target.name),
            format('revoke %s on %s from %I, and from PUBLIC and any role it is a member of', lower(privilege), target.name, member.rolname);
        end if;
      end loop;
      if not has_table_privilege(member.oid, target.relation, 'INSERT, UPDATE')
         and has_any_column_privilege(member.oid, target.relation, 'INSERT, UPDATE') then
        return query select 'fail', member.rolname::text, format('may write some columns of %s', target.name),
          format('revoke insert, update on %s from %I, column by column', target.name, member.rolname);
      end if;
      -- A role it could become, which can write. has_table_privilege above sees what is inherited; this sees what SET ROLE would reach.
      for writer in
        select rolname from pg_roles
         where oid <> member.oid and pg_has_role(member.oid, oid, 'MEMBER') and rolname not like 'pg\_%'
           and has_table_privilege(oid, target.relation, 'INSERT, UPDATE, DELETE, TRUNCATE')
      loop
        return query select 'fail', member.rolname::text, format('is a member of %s, which may write %s', writer.rolname, target.name),
          format('revoke %I from %I', writer.rolname, member.rolname);
      end loop;
    end loop;

    -- Functions that run with their owner's rights, which the agent may call, owned by a role that can write a protected table.
    for writer in
      select p.oid::regprocedure::text as name
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef and n.nspname not in ('keyturn', 'pg_catalog', 'information_schema')
         and has_function_privilege(member.oid, p.oid, 'EXECUTE')
         and exists (select from keyturn.protected
                      where has_table_privilege(p.proowner, relation, 'INSERT, UPDATE, DELETE, TRUNCATE')
                         or (select relowner from pg_class where oid = relation) = p.proowner)
       order by 1
    loop
      return query select 'fail', member.rolname::text, format('may run %s, which runs with the rights of a role that can write a protected table', writer.name),
        format('revoke execute on function %s from %I and from PUBLIC, or make the function security invoker', writer.name, member.rolname);
    end loop;
  end loop;

  for target in select relation, relation::text as name, shape from keyturn.protected order by 2 loop
    if target.shape <> keyturn.shape_of(target.relation) then
      return query select 'fail', target.name, 'has changed shape since it was protected, so no proposal for it can be made or applied',
        format('select keyturn.protect(%L)', target.name);
    end if;
    if exists (select from pg_trigger where tgrelid = target.relation and not tgisinternal) then
      return query select 'note', target.name, 'has triggers of its own. They run when a change is applied; a row they alter fails the apply unless the table is protected with exact => false', null::text;
    end if;
    if exists (select from pg_constraint where confrelid = target.relation and contype = 'f' and confdeltype in ('c', 'n', 'd')) then
      return query select 'note', target.name, 'is referenced by a foreign key that cascades. Deleting a row here changes rows in other tables, and those rows are not in the proposal', null::text;
    end if;
  end loop;

  for target in select r.name, r.relation::text as relation, r.operations, r.columns, r.max_rows, r.per_hour, r.condition is not null as conditional
                  from keyturn.rules r where r.active order by 1 loop
    return query select 'note', target.relation,
      format('the rule %s lets an agent %s%s with no person, up to %s rows a proposal and %s proposals an hour%s', target.name,
             array_to_string(target.operations, ', '), coalesce(' (' || array_to_string(target.columns, ', ') || ')', ''), target.max_rows, target.per_hour,
             case when target.conditional then ', under a condition' else '' end),
      format('update keyturn.rules set active = false where name = %L', target.name);
  end loop;

  if (select count(*) from pg_trigger where tgrelid = 'keyturn.audit'::regclass and tgname in ('audit_is_append_only', 'audit_is_not_emptied') and tgenabled in ('O', 'A')) < 2 then
    return query select 'fail', 'keyturn.audit', 'can be changed or emptied: the triggers that guard the audit log are missing or switched off',
      'alter table keyturn.audit enable trigger all'::text;
  end if;
  if exists (select from keyturn.verify_audit()) then
    return query select 'fail', 'keyturn.audit', 'does not hold together: entries were changed or removed, or a proposal moved without one', 'select * from keyturn.verify_audit()'::text;
  end if;
  if exists (select from pg_roles where rolname = 'keyturn_rule' and (rolcanlogin or rolsuper))
     or exists (select from pg_auth_members m where m.roleid = 'keyturn_rule'::regrole or m.member = 'keyturn_rule'::regrole) then
    return query select 'fail', 'keyturn_rule', 'is the name on record for a change no person approved, and here something can act as it', 'alter role keyturn_rule nologin nosuperuser, and revoke its memberships'::text;
  end if;

  if not exists (select from pg_roles where pg_has_role(oid, 'keyturn_approver', 'MEMBER') and rolcanlogin) then
    return query select 'note', 'keyturn_approver', 'has no login in it, so nothing can be approved', 'grant keyturn_approver to a login that is not an agent';
  end if;
end $$;

-- True when nothing fails. For a build to stand on.
create function keyturn.doctor_ok() returns boolean
  language sql
  set search_path = pg_catalog
  as $$ select not exists (select from keyturn.doctor() where level = 'fail') $$;

revoke all on function keyturn.doctor(), keyturn.doctor_ok() from public;
