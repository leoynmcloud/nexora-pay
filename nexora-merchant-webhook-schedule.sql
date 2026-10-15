-- Durable retry runner for merchant outbound webhooks.
-- Prerequisites:
--   1) Apply nexora-merchant-webhooks.sql.
--   2) Enable pg_cron and pg_net in Supabase Database > Extensions.
--   3) Store two Vault secrets (never paste credential values into this SQL):
--        nexora_supabase_project_url
--        nexora_merchant_webhook_worker_token
--   4) Set the same worker token as the Edge Function secret
--        NEXORA_MERCHANT_WEBHOOK_WORKER_TOKEN
-- The dedicated token can invoke only this worker; do not use the service-role key
-- as the scheduled job credential. pg_net briefly stores request headers in its
-- queue, so this low-scope token is not a general API key and must be rotated if
-- exposed. The worker still uses its server-side service key.
begin;

do $$
begin
  if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'Enable pg_cron before applying the merchant webhook schedule.';
  end if;
  if to_regnamespace('net') is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'Enable pg_net before applying the merchant webhook schedule.';
  end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Store the required values in Supabase Vault before applying this schedule.';
  end if;
  if not exists(select 1 from vault.decrypted_secrets where name='nexora_supabase_project_url')
     or not exists(select 1 from vault.decrypted_secrets where name='nexora_merchant_webhook_worker_token') then
    raise exception 'Missing required Supabase Vault secrets for merchant webhook scheduling.';
  end if;
end;
$$;

do $$
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname='nexora-merchant-webhook-deliveries';
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
  perform cron.schedule(
    'nexora-merchant-webhook-deliveries',
    '* * * * *',
    $job$
      select net.http_post(
        url := (select rtrim(decrypted_secret,'/') from vault.decrypted_secrets
          where name='nexora_supabase_project_url') || '/functions/v1/nexora-webhook-deliveries',
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'x-nexora-worker-token',(select decrypted_secret from vault.decrypted_secrets
            where name='nexora_merchant_webhook_worker_token')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 15000
      );
    $job$
  );
end;
$$;

commit;

-- Verify schedule presence and recent executions in the Supabase SQL editor:
select jobid,jobname,schedule,active from cron.job
where jobname='nexora-merchant-webhook-deliveries';

select jobid,status,return_message,start_time,end_time
from cron.job_run_details
where jobid=(select jobid from cron.job where jobname='nexora-merchant-webhook-deliveries')
order by start_time desc limit 20;
