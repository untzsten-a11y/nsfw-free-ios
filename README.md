# NSFW-free iOS

**A Safari userscript and setup guide**

This project is an approach to keeping NSFW content off your iPhone or iPad. It has two parts:

1. **The userscript** (`nsfw-blocker.user.js`) blurs NSFW images and videos in Safari and blocks
   adult sites. Every image is checked on your device; nothing is sent anywhere. It runs in the free
   [Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887) app.
2. **The guide** ([More ways to protect yourself](#more-ways-to-protect-yourself)) locks down the
   rest of iOS: Screen Time, other browsers and apps, DNS filters and everyday habits.

Neither part is a definitive solution on its own, but together they remove most of the ways NSFW
content reaches you, and give you a moment to stop and think when it does.

## Installation

It takes about 5 minutes. You need an iPhone or iPad with iOS 15 or newer.

**1. Install the Userscripts app.** Get
[Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887) from the App Store. It's free.

**2. Create a folder for your scripts.** Open the **Files** app → **Browse** → **On My iPhone** →
tap **⋯** (top right) → **New Folder**. Name it `Userscripts`.

**3. Point the Userscripts app to that folder.** Open the **Userscripts** app → tap **Set
Userscripts Directory** (called **Change Userscripts Directory** if a folder is already set) →
pick **On My iPhone → Userscripts** → **Open**.

**4. Download the script into the folder.**
1. In Safari, open
   [`nsfw-blocker.user.js`](https://raw.githubusercontent.com/untzsten-a11y/nsfw-free-ios/main/nsfw-blocker.user.js).
   It shows as a page of code.
2. Tap the **Share** button → **Save to Files** → **On My iPhone → Userscripts** → **Save**.
3. Open the folder in Files and check that the file is named exactly `nsfw-blocker.user.js`.
   If Safari added `.txt`, long-press the file → **Rename** and remove it.

Other ways to get the file into the folder:
- **Downloaded somewhere else** (for example the **Downloads** folder, from GitHub's "Download raw
  file" button): in Files, long-press the file → **Move** → **On My iPhone → Userscripts**.
- **From a computer:** put the file in **iCloud Drive** (on the web at icloud.com, or in Finder
  on a Mac). Then move it in Files as above. Or send it with **AirDrop** from a Mac: it lands in
  **Downloads**, so move it from there.
- **Email or Messages:** send the file to yourself, tap the attachment → **Share** → **Save to
  Files** → **On My iPhone → Userscripts**.
- **Only the text:** create a new empty file named `nsfw-blocker.user.js` in the folder with a text
  editor app (see [Changing the settings](#changing-the-settings)) and paste the whole script into
  it.

The Userscripts app only runs files that are directly in the chosen folder and end in `.user.js`.

**5. Turn on the extension in Safari.** Settings → **Apps** → **Safari** → **Extensions** →
**Userscripts** (on iOS 17 and older: Settings → Safari → Extensions → Userscripts):
- turn **Userscripts** on;
- under **Permissions**, set **All Websites** to **Allow**;
- turn on **Allow in Private Browsing**.

**6. Check that it works.** Open a website with pictures in Safari. Images are blurred for a moment,
then the safe ones unblur. Tap **aA** in the address bar → **Userscripts**: `NSFW Image Blur` should
be listed and switched on.

**Updating:** repeat step 4 and replace the old file.

That's all: the script is a single file. TensorFlow.js and the model (nsfwjs MobileNetV2) are
downloaded from jsDelivr the first time a page has an image to check. Each download's SHA-256 hash
is checked, and a file that doesn't match is never run.

## How it works

### The model

Images are checked by [**nsfwjs**](https://github.com/infinitered/nsfwjs) (by Infinite Red), a
MobileNetV2 image classifier trained in the [nsfw_model](https://github.com/GantMan/nsfw_model)
project. It runs entirely on your device with [TensorFlow.js](https://github.com/tensorflow/tfjs),
using the phone's GPU. No image ever leaves the phone.

The model scores each image in five categories: **Drawing**, **Hentai**, **Neutral**, **Porn** and
**Sexy**. The script first looks at the whole image. If the result is borderline, it also checks a
zoomed-in center crop. The image is NSFW if either view scores high on Porn or Sexy. A high Hentai
score only counts together with some Porn score, or when both views agree it is drawn explicit
content. Without that rule, car interiors, leather and machinery get blocked.

The model is right about 90% of the time. Some NSFW images will get through, and some safe ones
will stay blurred.

### Images and videos

- Every image, video and inline background image is **blurred immediately** and can't be
  tapped, long-pressed or dragged until it is checked.
- Images are checked once they have loaded, as they come near the screen (up to 4 at a time).
  Icons smaller than 48 px and plain SVG icons count as safe without a check. An image shown
  several times is checked once, and verdicts are remembered for later visits.
- When a page swaps an image (lazy loading, responsive images), the new image is blurred and
  checked again.
- Videos stay blurred and muted until their poster or a playing frame is judged safe (black
  frames are skipped). Playing videos are re-checked every 12 seconds. Unverified video can't go
  fullscreen or Picture-in-Picture.
- A confirmed-NSFW video can't be started again, its source is removed, and its player area
  and any links to its file can't be tapped or long-pressed (so no Download/Save).
- Small iframes (under 200 px, usually ads) don't load the model: their media stays blurred.

### Whole-page blocks

A page is **blocked entirely** when:
- its hostname is an obvious adult site;
- its text shows it's an adult site: explicit words **plus** a sign the site labels itself
  adult (RTA tag, 2257 notice, age statement, or a menu of explicit categories). Words alone
  never block, search results for your own query are skipped, and so are encyclopedias.
  Blocks the domain for 5 minutes;
- at least 6 of its images are NSFW, and they make up at least 60% of the images checked.
  Blocks the domain for 15 minutes.

### If something fails

- If the model can't load, or a downloaded file fails its hash check, media stays blurred but
  taps work again so the page stays usable.
- An image that can't be downloaded is retried once, then stays blurred.

### What it can't catch

Images set in a site's CSS files, `<canvas>` drawings, and text. Cross-origin videos without a
poster stay blurred, but their frames can't be checked. The script only runs in Safari with the
Userscripts extension turned on. For stronger protection, also turn on iOS **Limit Adult Websites** (see
[More ways to protect yourself](#more-ways-to-protect-yourself)), or use a family DNS filter such as
Cloudflare's 1.1.1.3.

## Changing the settings

The settings are plain text near the top of `nsfw-blocker.user.js`, under `// ----- settings -----`.
You can change them on the iPhone itself:

1. Install a text editor that can edit files in the Files app, for example **Runestone** (free)
   or **Textastic**. The Files app itself can't edit text.
2. In the editor, open **On My iPhone → Userscripts → nsfw-blocker.user.js**. Open the file where
   it is; don't import a copy, or the Userscripts app won't see the change.
3. Make the change and save.
4. Reload the page in Safari. The new settings apply from then on.

Or edit the file on a computer and copy it to the phone again (see step 4 of
[Installation](#installation)).

**Changes you might want to make:**

| Setting | What it does | Example |
| --- | --- | --- |
| `WHITELIST` | Sites where the script does nothing (subdomains included). Write only the domain, no `https://` or `www.`. | `['youtube.com', 'youtube-nocookie.com', 'mybank.com']` |
| `HARD` | Words that block a site when they're in its address, and that count as adult words in page text. Separated by `\|`, lowercase. | add `\|mynewword` before the last `/` |
| `SOFT` | Ambiguous words that only count as whole words in short links. | add `\|word` inside the brackets |
| `HOST_EXCEPTIONS` | Addresses that contain a `HARD` word but are fine (e.g. the town Pornic). | `/pornic\|myexception/` |
| `TEXT_SKIP` | Reference sites where page text is never checked (images still are). | add `'mysite.com'` |
| `DEBUG` | `true` shows the red status badge (tap it to hide). | `var DEBUG = true;` |
| `PAGE_BLOCK_NSFW`, `PAGE_BLOCK_RATIO` | How many NSFW images, and what share of the checked ones, block the whole page. | `4` and `0.5` block sooner |
| `PAGE_BLOCK_MINUTES`, `TEXT_BLOCK_MINUTES` | How long a blocked domain stays blocked. | `60` |

**Be careful:**
- Keep the quotes, commas, brackets and the `;` at the end of each line. One missing character
  stops the whole script, and then **nothing** is blurred. After editing, open a page with
  pictures and check that images are blurred for a moment.
- Don't change `MODEL_URL`, `TF_URL` or `HASHES`. If they don't match, the model won't load.
- **Updating replaces the file**, so your changes are lost. Write them down and make them again
  after each update.

## Privacy

- Everything runs on your device. The script has no server and no analytics, and it sends nothing
  to its authors.
- The only third party it contacts itself is jsDelivr, to download TensorFlow.js and the model.
  jsDelivr sees your IP address when it does.
- To check an image, the script may download it again from the site that shows it, sending only that
  site's origin (not the full page address) as the Referer.
- Image verdicts (up to 3000 image addresses) and recently blocked domains are stored by the
  Userscripts app on your device only. No cookies are set on the sites you visit.

## Contributing

Issues, reports and code changes are very welcome. This project gets better with every site
people test it on.

- **Found a bug, or is something slow?** [Open an issue](https://github.com/untzsten-a11y/nsfw-free-ios/issues).
  Include the website, what happened, your iOS version and the script version. To see the version,
  set `DEBUG = true`: the red badge shows it and the counts.
- **An image got through, or a safe image stays blurred?** Report it too, but **don't post NSFW
  images or links to explicit pages** in an issue. Name the website and describe the kind of image
  instead (for example "swimwear photos on a shopping site stay blurred").
- **A site is blocked that shouldn't be, or an adult site isn't blocked?** Say which site, and
  whether the page text, the images or the address caused it (the badge shows the reason).
- **Code changes:** pull requests are welcome, small or large. Keep the style of the surrounding
  code, explain what the change fixes, and test it on an iPhone or iPad in Safari if you can.
  Contributions are released under the same [Unlicense](LICENSE) as the rest of the project.
- **Ideas and questions** are welcome as issues too.

## License and credits

Public domain ([the Unlicense](LICENSE)). While running, the script downloads
[TensorFlow.js](https://github.com/tensorflow/tfjs) (Apache-2.0) and the
[nsfwjs](https://github.com/infinitered/nsfwjs) MobileNetV2 model by Infinite Red (MIT); neither is
included in this repository.

## More ways to protect yourself

This script is **not a definitive solution**. A determined person can always find a way around a
filter. It's a tool to help with the first step: fewer accidental encounters, fewer triggers, and a
moment to stop and think before going further. It works best together with the tips below, and with
support from people you trust. Setting paths are for recent iOS versions and may differ slightly on
yours.

### Lock down the phone (Screen Time)

- **Let someone you trust set the Screen Time passcode:** Settings → Screen Time → Lock Screen
  Time Settings. Without it, every setting below can be switched off in seconds.
- **Limit adult websites:** Screen Time → Content & Privacy Restrictions (turn it on) →
  **Content Restrictions → Web Content → Limit Adult Websites**. In Swedish: Skärmtid →
  **Innehållsbegränsningar → Webbinnehåll → Begränsa vuxet innehåll**. This blocks known adult
  sites in every app. It also turns off Safari's Private Browsing, so this script can't be skipped
  that way.
- **Block specific websites:** on the same page, add sites under **Never Allow**.
- **Stop new apps from being installed:** Content & Privacy Restrictions → iTunes & App Store
  Purchases → **Installing Apps → Don't Allow**. Set **Deleting Apps → Don't Allow** as well, so
  Userscripts can't be removed.
- **Limit Safari time:** Screen Time → App Limits → Add Limit → Safari (for example 1 hour a day).
- **Downtime at night:** Screen Time → Downtime. Late evenings are when most people are most
  vulnerable.

### Remove the ways around it

- **Delete every other browser** (Chrome, Firefox, Edge, and so on). The script only runs in Safari.
- **Watch out for apps with their own built-in browser or explicit feeds:** Reddit, X/Twitter,
  Tumblr, Telegram, Discord and similar. Links opened inside them skip Safari and this script.
  Delete the ones you don't need, or limit them with App Limits.
- If you use Private Browsing, allow the extension there: Settings → Apps → Safari → Extensions →
  Userscripts → Allow in Private Browsing.

### Filter at the network level

- **AdGuard for iOS:** a Safari content blocker. Its DNS protection with the **AdGuard DNS Family**
  server blocks adult sites in all apps, not just Safari.
- **A family DNS filter**, with or without an app: **Cloudflare 1.1.1.3** (1.1.1.1 for Families),
  **CleanBrowsing Family**, or **NextDNS** with a custom blocklist. Installed as a DNS profile, it
  works on every network.
- **Safe search:** turn on Google SafeSearch and YouTube Restricted Mode. The family DNS filters
  above can enforce both.

### Make the phone less tempting

- **Greyscale:** Settings → Accessibility → Display & Text Size → Color Filters → Grayscale. Set
  Accessibility → Accessibility Shortcut → Color Filters to toggle it with a triple-click of the
  side button. A grey screen is much less rewarding to scroll.
- **Clean up your feeds:** unfollow triggering accounts, and use "Not interested" on
  recommendations.
- **Keep the phone out of the bedroom at night.** Charge it in another room.
- **Talk to someone:** a friend, a partner, a support group or a professional. Accountability apps
  such as Covenant Eyes or Ever Accountable can share reports with a person you trust.
