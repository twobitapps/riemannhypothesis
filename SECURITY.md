# Security

Please report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on this repository (a private security
advisory). Do not open a public issue for a security problem.

Useful details: what is affected (client, coordinator, site), steps to
reproduce, and what an attacker could do. We aim to acknowledge reports within
a few days and will credit you by GitHub handle unless you ask us not to.

What the client is and is not allowed to do on a contributor's machine is set
out in [docs/SAFETY.md](docs/SAFETY.md). Anything that breaks one of those
rules (code running outside the sandbox, data leaving the machine, credentials
being read or sent) is a security bug.
