# Christabel Oboh — website

One site, three parts, one domain: the portfolio (`/`), the Blog (`/blog/`) and Infobytes (`/infobytes/`), plus About, Contact, Privacy, Terms and Disclaimer pages that AdSense expects.

## Put it online with Cloudflare (Workers)
1. Put the project on GitHub. If the files sit inside a folder in the repo, set that folder as the Root directory in Cloudflare.
2. Cloudflare → Workers & Pages → Create → connect the repository. Build command `npm run build`, deploy command `npx wrangler deploy`. `wrangler.jsonc` and `worker.js` tell Cloudflare how to serve the site and run the editor sign-in.
3. Add your domain: open the Worker → Settings → Domains & routes → Add → Custom domain → `theceo.dev` (the domain must be on Cloudflare).
4. If your address is not `theceo.dev`, change it in `astro.config.mjs` and `public/robots.txt`.

## Nothing empty is shown to visitors
- No ad boxes appear until you switch ads on (see below). The portfolio never shows ads.
- The Blog says "New posts are on the way" until you publish a post. Infobytes says "No opportunities listed right now" until you add one. Add real posts before you share the links.
- The Certifications and Experience tabs, and the CV button, only appear when they have content. Upload your CV in Site settings → Portfolio text, links and photo.
- Want to see the design with sample content? Copy the files in `_samples/posts` and `_samples/opportunities` into `src/content/posts` and `src/content/opportunities`, then delete them before going live.

## AdSense
1. Apply with your domain. In AdSense choose the **meta tag** verification method. Paste your publisher ID (`ca-pub-...`) into the editor under Site settings → Ads, contact and Blog / Infobytes settings. The meta tag then appears on every page without showing any ad.
2. Once approved, create an ad unit in AdSense, paste its ID into "AdSense ad unit ID" and switch on "Show ads on Blog and Infobytes". Ads then appear only on blog posts, the blog list and Infobytes, never on the portfolio, About, Contact or policy pages.
3. `/ads.txt` is generated for you from the publisher ID.
4. For visitors in Europe and the UK, turn on Google's free consent message in AdSense (Privacy & messaging).
5. The Privacy, Terms and Disclaimer pages are general starting texts. Read them and change anything that does not match how you work. They are not legal advice.

## Connect your newsletter (the box stays hidden until you do)
The same newsletter box appears on the Blog and on Infobytes (with different wording), and the **Add to calendar** reminder appears on every Infobytes opportunity that has a deadline in the future.
1. Create your list in your newsletter tool (Kit, beehiiv, MailerLite, Brevo and others have free plans).
2. Find its **sign-up page link** (a hosted page or share link).
3. In the editor go to Site settings → Ads, contact and Blog / Infobytes settings, paste it into **Newsletter: sign-up page link**, and save. The Subscribe button now opens that page.
Optional: if your tool gives you a plain HTML form, paste the form's address into **form address** and its email field name into **email field name** to show an email box directly on the site. If the form needs extra hidden fields, use the sign-up page link instead.
You can change the wording of both boxes in the same place.

## The content editor
Go to `https://theceo.dev/admin/` and sign in with GitHub. Sign-in is handled by `worker.js`. To switch it on:
1. In `public/admin/config.yml` put your repository in the `repo:` line, for example `yourname/theceo-site`. If the project sits inside a folder in your repo, use `config-for-subfolder.yml` instead.
2. Create a GitHub OAuth app (GitHub → Settings → Developer settings → OAuth Apps → New). Homepage URL `https://theceo.dev`, callback URL `https://theceo.dev/api/callback`.
3. In Cloudflare open the Worker → Settings → Variables and secrets. Add `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, both as **Secret** type, then redeploy.

## Working locally
`npm install` then `npm run dev`. Design changes live in `src/styles/site.css` and the files in `src/`.
