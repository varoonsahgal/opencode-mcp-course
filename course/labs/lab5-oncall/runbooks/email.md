# Runbook: Email Sender

**Symptoms:** 5xx from `/send`, webhook queue depth climbing, password-reset emails missing.

1. Check provider status (Postmark). If the provider is down, switch `EMAIL_PROVIDER` to the secondary (SES) and redeploy.
2. If the provider is healthy, inspect the worker pods for OOM kills; the usual fix is scaling workers 3 → 6.
3. Queue depth > 50k: enable `drop_marketing_mail` so transactional mail goes first.
4. Page `@growth-oncall` for anything sev1.
