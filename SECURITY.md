# Security notes

This connector handles confidential law-firm information. Deploy it only in an account controlled by the firm or its approved administrator.

- Keep the GitHub repository private.
- Store `CLIO_CLIENT_SECRET`, `DATABASE_URL`, and `TOKEN_ENCRYPTION_KEY` only as hosting secrets.
- Never send those values by email, paste them into ChatGPT, commit them to Git, or include them in screenshots.
- Give the Clio developer app only the read permissions it needs.
- Require each user to connect their own Clio account. Their Clio role remains the final limit on what they can see.
- Keep the server and dependencies updated and review hosting access periodically.
- Treat calendar details, tasks, matters, and user information as confidential client or firm data.

If a secret is exposed, rotate it immediately in Clio or Render, redeploy the service, and require users to reconnect.
