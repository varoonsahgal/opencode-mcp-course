# Runbook: Checkout API

**Symptoms:** p95 > 1s, error rate > 2%, "payment pending" complaints.

1. Check the last deploy of `payments-gateway`. A latency regression after a deploy is the most common cause.
2. Compare `checkout` p95 with the upstream PSP status page. If the PSP is slow, enable the `psp_timeout_fallback` flag.
3. If the regression started with a deploy and the PSP is healthy: **roll back** via the deploy tool, then page `@payments-oncall`.
4. Never restart the checkout fleet during peak hours (16:00–20:00 UTC); it drops in-flight payments.
