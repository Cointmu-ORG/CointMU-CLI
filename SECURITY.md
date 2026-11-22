# Security Policy

## Reporting a Vulnerability

Do not post security findings in public issues, pull requests or discussions. Anyone can read them, including people who could use the finding against other users.

Report a security issue privately through GitHub's private vulnerability reporting:

1. Go to the **Security** tab of this repository and select **Report a vulnerability**.
2. Fill in the form and submit it. Only you and the maintainers can see the report.

If the issue is in another CointMU product, report it on that product's repository instead. The [Hall of Fame](https://coint-mu-docs.vercel.app/docs/hall-of-fame.html) page lists them.

## What a Good Report Contains

- **Product and version**: which product, and which version (for the CLI, the output of `cmu version`). For the docs site, the page URL.
- **Steps to reproduce**: the exact commands or clicks, from a fresh setup if you can.
- **Actual and expected behavior**: what happened, and what you expected to happen. Copy error messages as text.
- **Impact**: who is affected and what could go wrong, for example exposed keys, lost funds or a wrong balance.

Never put a real seed phrase, private key or password in a report.

We aim to acknowledge reports within 72 hours and to provide a remediation timeline after triage. We will coordinate a disclosure date with you once a fix is available.

## Scope, Rules and Credit

The scope, the testing rules and how findings are credited are on the [Hall of Fame](https://coint-mu-docs.vercel.app/docs/hall-of-fame.html) page. Test only with your own accounts and on an isolated local chain, never on the shared campus network.

There is no reward for a report. A finding is credited on the Hall of Fame page only after its fix has been released, and only with the reporter's consent.
