# Runbook: Auth Service

**Symptoms:** login failures, token validation errors across all services.

1. Auth is tier 1 and stateful. **Do not restart** without the identity lead on the call; a cold restart logs out every user.
2. Check certificate expiry first (`auth-cert-expiry` alert), then the IdP status page.
3. Page `@identity-oncall` for anything above sev3.
