# The CEO site

Welcome! This is the code behind my portfolio, blog, and Infobytes listings at [theceo.dev](https://theceo.dev). If you're helping me with the site, here's how it works and where to start.

## How the site works

I built the site with Astro and run it on Cloudflare Workers. Astro turns the site's content into pages, and the Worker serves those pages when someone visits. The site content is stored in Cloudflare D1, a small SQLite database.

I use the `/administrator` page to edit posts, opportunities, portfolio details, and other site content. Those edits go straight into the database and appear on the site without a code change or deployment. The files in `seed/content/` are starter content for a new database; they don't automatically update when I edit the live site.

To change how the site looks or works, update the code in `src/`, `worker.js`, or `worker/`, then build and deploy it. Code changes and content edits are separate: code changes go through GitHub, while content edits in the admin do not.

## Admin access

The editor is at [theceo.dev/administrator](https://theceo.dev/administrator). It uses a password, not GitHub sign-in. The initial login requires an `ADMIN_PASSWORD` secret in Cloudflare; the username is `admin` unless `ADMIN_USERNAME` has been set. Once signed in, I can change the username and password under **Account → Password & login**.

Please don't put passwords or other secrets in this repository. `SESSION_SECRET` is also recommended in Cloudflare to sign admin sessions.

## The hourly news and draft job

Cloudflare is configured in this repository to run a scheduled job once an hour. It looks for stories in Google News and Bing News, sorts and saves them, then can use Cloudflare Workers AI to prepare new posts.

The default settings are to make Infobytes opportunities and save them as **drafts**. They are not published automatically unless that setting is changed in the admin. You can also choose Blog or both, pause the job, or run it manually from **Auto-posting**.

The automation tries to check that an opportunity is still open and that key details, such as the organisation, application link, and deadline, appear on the source page. Blog drafts are checked for similarity to existing posts. These checks help, but AI can still get things wrong, so please verify the source and details before publishing.

If a draft doesn't appear, the Auto-posting page has run history and skip reasons. The job can also pause when it reaches its AI daily budget or request limits, or when a news source is unavailable.

## Running and deploying the site

You'll need Node.js installed. From the project folder:

```sh
npm install
npm run dev
```

To build or deploy:

```sh
npm run build
npm run deploy
```

`npm run deploy` builds the site and deploys the Worker. It needs access to the Cloudflare account and the required Cloudflare settings.

If you update the starter content in `seed/content/`, run `npm run seed` to regenerate the seed files. This is for setting up new databases; it doesn't copy live admin edits back into the repository.

## Cloudflare settings to check

`wrangler.jsonc` shows the bindings this project expects, but it doesn't tell us exactly what is configured in the live Cloudflare account. Before setting up a deployment, check that:

- The D1 binding `DB` points to the right database. The checked-in config names the database but is missing its `database_id`.
- The `NEWS` KV namespace has an ID in the config. The `FILES` KV namespace is declared but its ID is missing.
- The Worker has the `ADMIN_PASSWORD` secret. Add `SESSION_SECRET` too if possible.
- The `AI` binding is enabled if you want AI drafts.

The code can use an R2 bucket binding called `MEDIA` for uploads, but R2 isn't enabled in the checked-in config. It falls back to `FILES` KV storage. I can't confirm from this repository which settings are already configured for the live site.

## GitHub access and pull requests

The site editor and GitHub access are different things. Editing a post in the admin changes the live site's database; it doesn't need GitHub access. Changing the code does.

Someone can have collaborator access to the repository and still need to make a pull request if branch rules require it. A pull request is just a way to propose and review code changes before they go into a branch. Coding agents often use a separate branch and open a PR as part of their workflow; that doesn't necessarily mean the person using the agent lacks access. To check who has access or what rules apply, look in the repository's **Settings → Collaborators** and **Rules / Branches**.
