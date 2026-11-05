# EmDash Vercel Sandbox integration

Keep the released EmDash app unchanged. The primary setup is the published shell installer, browser authorization, and one SSH-config selection in EmDash. Keep all runtime files outside temporary installer directories. Preserve existing SSH configuration, host state, credentials, and failed-run evidence.

Use pnpm with the committed lockfile. Run `pnpm test` and `pnpm run check`. Release verification also requires `pnpm run test:release -- --archive PATH` with a freshly built archive. Never claim fresh-user authorization or desktop E2E from unit or packaging tests. Do not commit private state, credentials, logs, personal paths, or local evidence packets.
