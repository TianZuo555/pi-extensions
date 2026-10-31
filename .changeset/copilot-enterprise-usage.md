---
"@tian.zuo/pi-usage": patch
---

Use the GitHub Enterprise Cloud data-residency domain saved with Pi's Copilot OAuth credential when querying account usage, so `<tenant>.ghe.com` accounts can populate `/usage` and the footer meter. Keep public GitHub behavior and the existing credits/request labels.

Reject invalid or unsupported Enterprise domains before sending credentials, do not follow Copilot usage redirects or replay failed requests on a different account domain, and restrict the VS Code public-token fallback to `github.com` accounts.
