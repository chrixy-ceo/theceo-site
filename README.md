# The CEO site

This repository contains the portfolio, blog, and Infobytes opportunity listings for [theceo.dev](https://theceo.dev). The site is built with Astro and runs as a server-rendered Cloudflare Worker.

## A quick map

If you are new to the project, these are the main pieces:

| Name | In plain language | Used for |
| --- | --- | --- |
| Astro | The website framework | Builds pages and renders each request |
| Cloudflare Worker | A small program running at Cloudflare's edge | Serves the site, admin, uploads, and scheduled job |
| D1 | Cloudflare's SQLite database | Current content, settings, and edit history |
| KV | Cloudflare's key-value storage | Login throttling, setup markers, and legacy data migration |
| Workers AI | Cloudflare-hosted AI models | Optional news screening and draft writing |
| R2 | Cloudflare object storage | Optional media storage; KV is the configured fallback |

The public pages are the portfolio (`/`), blog (`/blog/`), Infobytes (`/infobytes/`), and the other content pages. Astro renders them on request using content loaded from D1; this is not a static-only site and it is not deployed as Cloudflare Pages.

## How a request becomes a page

1. `npm run build` builds the Astro app and its Cloudflare Worker output in `dist/`.
2. `wrangler deploy` deploys `worker.js` and the built assets described in `wrangler.jsonc`.
3. The Worker initializes the D1 schema if needed, then sends `/administrator` and `/uploads/*` to their handlers. Other requests go to Astro.
4. Astro middleware reads content from D1. The pages parse JSON and Markdown content and render the result.

The database is the live source of content. The checked-in starter content is under `seed/content/`; `scripts/seed-d1.mjs` generates both the SQL seed migration and the JSON seed bundled with the Worker. On a first request with an empty D1 database, the Worker creates its tables and inserts the bundled seed content. It does not overwrite existing content.

## Editing content and code

### Change words, listings, or portfolio details

Sign in at `https://theceo.dev/administrator`. The editor can update blog posts, opportunities, pages, projects, certifications, profile settings, and media. These edits are written directly to D1 (or the configured media store), so they do **not** make a Git commit, open a pull request, or require a code deployment.

The editor's content paths look like `src/content/posts/example.md`, but the live files are D1 rows—not files in a checked-out `src/content` directory. The repository's `seed/content/` files are starter data for a new database; they are not automatically kept in sync with edits made in the admin.

Auto-generated posts also go straight into D1. Infobytes and blog drafts are visible in their admin draft lists, where you can review, publish, or delete them.

### Change layout, features, or Worker behavior

Those are code changes in this repository. They need a build and deployment before the live site changes. For example, page layouts and components are in `src/`, the request and scheduled-job entry point is `worker.js`, and admin/auth/news logic is in `worker/`.

Useful commands from `package.json`:

```sh
npm install
npm run dev
npm run build
npm run deploy
```

`npm run deploy` builds and deploys. The build script uses Unix shell commands (`rm` and `printf`), so on Windows use a Bash-compatible shell such as Git Bash or WSL. Local database and secret setup is not fully described in this repository; a local preview may need Cloudflare bindings configured before it can load content.

When changing starter content in `seed/content/`, run `npm run seed` to regenerate `migrations/0002_seed.sql` and `worker/seed.json`, then apply the migration as appropriate. `npm run db:migrate` applies migrations to the remote D1 database. Avoid treating this as a way to copy live admin edits back into Git.

## Admin sign-in and security

The current editor is a custom password-protected page served at `/administrator`. The old README's GitHub OAuth, Decap CMS, `/admin/`, and OAuth callback instructions do not match the current code and should not be used.

The initial login needs the Cloudflare Worker secret `ADMIN_PASSWORD`. Unless `ADMIN_USERNAME` is set, the initial username is `admin`. `SESSION_SECRET` is recommended as a separate secret for signing sessions; the code falls back to a value derived from `ADMIN_PASSWORD` if it is absent. After signing in, use **Account → Password & login** to set a new username and password. The new password is stored as a salted hash in D1, not as plain text. Sessions expire after 12 hours, and changing the password invalidates other sessions.

The code also checks same-origin requests, uses a secure HTTP-only session cookie, and applies login-attempt throttling when the `NEWS` KV binding is available. These are code behaviors; they do not prove that the production Worker has the required secrets or bindings configured.

## Hourly news and AI drafts

`wrangler.jsonc` declares a Worker cron trigger of `0 * * * *` (once an hour). If that trigger is active on the deployed Worker, the scheduled handler:

1. Collects Google News and Bing News RSS results for categories present on the site, plus any extra categories configured in the admin.
2. Ranks and deduplicates results, then saves the latest results and run history in D1.
3. If auto-posting is enabled and Workers AI is available, tries to create posts for the selected target.

The code defaults to **Infobytes**, with auto-posting enabled but **publishing disabled**. That means generated items are saved as drafts for review, not published immediately. The admin can change the target to Blog or both, pause collection or auto-posting, adjust categories and search settings, test AI, and run the job manually.

For Infobytes, the pipeline checks a source page for an open opportunity, asks AI to extract details, and verifies some important facts such as organization, application link, and deadline before saving a draft. For blog posts, AI writes an article from a news item and checks for close matches to existing posts. These checks reduce errors; they do not guarantee that AI-generated details are correct, so review drafts before publishing.

The job has limits: a run shares a budget of at most 45 outside requests, the opportunity writer creates at most two listings per run, and AI calls pause at the code's daily budget. A failed news source can leave the last successful results in place. Check the Auto-posting screen's run history and skips/errors when something does not appear.

## Cloudflare setup: what the repository says and what is missing

The checked-in configuration is `wrangler.jsonc`. It describes the intended bindings, but it does **not** show the live Cloudflare account's deployed settings. Before deploying, verify these bindings in Cloudflare and complete the missing identifiers:

| Binding or secret | Purpose | State in this repository |
| --- | --- | --- |
| `ASSETS` | Serves the built files from `dist/` | Declared in `wrangler.jsonc` |
| `DB` | D1 content database named `theceo-content` | Binding and migrations directory are declared, but **`database_id` is missing** from the checked-in config; confirm or add the real D1 database ID |
| `NEWS` | KV namespace used for login throttling, setup markers, and one-time legacy-state import | Binding and namespace ID are present in `wrangler.jsonc` |
| `FILES` | KV fallback for uploaded media | Binding is declared, but **its KV namespace `id` is missing** |
| `MEDIA` | Optional R2 media bucket instead of `FILES` | Not enabled; the R2 configuration is only shown as a comment in `wrangler.jsonc` |
| `AI` | Workers AI used by the scheduled draft pipeline | AI binding is declared; confirm it is enabled for the deployed Worker |
| `ADMIN_PASSWORD` | Initial admin login password | **Not in the repository; add it as a Cloudflare Worker secret** |
| `SESSION_SECRET` | Preferred key for signing admin sessions | Not in the repository; recommended as a Cloudflare Worker secret |
| `ADMIN_USERNAME` | Optional initial username (defaults to `admin`) | Not in the repository; optional Worker variable |

`DB` and either `FILES` or `MEDIA` are needed for the full editing experience; `ADMIN_PASSWORD` is needed to sign in before a password has been set in the editor. `AI` is needed for AI-generated drafts, not for rendering ordinary site pages. The code can still run some authentication behavior without `NEWS`, but its configured KV namespace provides the login throttling and migration/setup behavior.

If choosing R2 for uploads, configure a `MEDIA` bucket binding in `wrangler.jsonc`; `scripts/seed-r2.mjs` can copy the existing `public/uploads/` files to the `theceo-media` bucket. Keep credentials and secrets out of Git. The repository cannot confirm whether any of these missing settings have already been supplied through Cloudflare's dashboard or deployment environment.

The custom domain `theceo.dev`, Worker name, cron schedule, and compatibility date are declared in `wrangler.jsonc`. These declarations describe intended deployment behavior, not proof that the domain, database, storage, AI access, or cron is currently active in the live Cloudflare account.

## GitHub collaborators, branch rules, and pull requests

GitHub access and the website editor are separate:

- A **collaborator** is someone granted repository access. Their role controls what they may do to GitHub code and branches.
- **Branch protection or repository rules** are separate settings that can require changes to go through a pull request, even for someone who can write to the repository.
- A **pull request (PR)** is a proposed code change for review. Coding agents often work on a separate branch and propose a PR by design. That is normal and does not, by itself, mean the person lacks collaborator access.
- The site admin changes live D1 content; it does not use a collaborator's GitHub access and does not create PRs.

Whether someone or an agent can push directly to a particular branch depends on their GitHub permissions, authentication, and that repository's branch rules. Those live settings are not stored in this codebase, so check the repository's **Settings → Collaborators** and **Rules / Branches** pages to confirm them.

## Known caveats

- The D1 ID and `FILES` KV namespace ID are absent from the checked-in Wrangler config. Verify them before relying on a deployment; the config alone cannot establish that production has them.
- Admin content and generated posts live in D1, while starter content lives in Git. These are different copies with different update paths.
- A successful AI run is not editorial approval. Verify dates, eligibility, application links, source attribution, and claims before publishing.
- Cloudflare may change product limits, free allowances, or dashboard labels. The code's limits and this setup guide describe this repository, not a guarantee of current Cloudflare pricing or account configuration.
