# Branch protection

Apply these GitHub settings on `main` after the remote exists. They are repository
settings, not runtime code.

- Require the `CI / test` status check before merge
- Do not allow force pushes
- Do not allow deletions
- Enable secret scanning and push protection
