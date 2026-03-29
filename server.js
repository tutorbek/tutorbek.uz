const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = __dirname;
const BLOG_DIR = path.join(ROOT_DIR, "blog");
const POSTS_JSON_PATH = path.join(BLOG_DIR, "posts.json");
const AUTH_CONFIG_PATH = path.join(ROOT_DIR, "config", "createpost-auth.json");
const AUTH_COOKIE_NAME = "createpost_auth";
const MEDIA_DIR = path.join(BLOG_DIR, "media");
const MEDIA_MAX_SIZE_BYTES = 10 * 1024 * 1024;
const TELEGRAM_CONFIG_PATH = path.join(ROOT_DIR, "config", "telegram.secure.json");
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "https://tutorbek.com").replace(/\/$/, "");
const LINK_PREVIEW_TIMEOUT_MS = 7000;
const LINK_PREVIEW_MAX_HTML_CHARS = 350000;

const CONTENT_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".eot": "application/vnd.ms-fontobject",
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".jpg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".woff": "font/woff",
};

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }

    if (!chunks.length) return {};

    const raw = Buffer.concat(chunks).toString("utf8");
    try {
        return JSON.parse(raw);
    } catch {
        throw new Error("Invalid JSON body");
    }
}

async function readTextBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function stripTags(value) {
    return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[ch]));
}

function transliterate(value) {
    const normalized = String(value || "")
        .replace(/[’ʻ`]/g, "'")
        .replace(/g'/gi, "g")
        .replace(/o'/gi, "o")
        .replace(/sh/gi, "sh")
        .replace(/ch/gi, "ch");

    const map = {
        a: "a", b: "b", d: "d", e: "e", f: "f", g: "g", h: "h", i: "i", j: "j", k: "k", l: "l", m: "m",
        n: "n", o: "o", p: "p", q: "q", r: "r", s: "s", t: "t", u: "u", v: "v", x: "x", y: "y", z: "z",
        A: "a", B: "b", D: "d", E: "e", F: "f", G: "g", H: "h", I: "i", J: "j", K: "k", L: "l", M: "m",
        N: "n", O: "o", P: "p", Q: "q", R: "r", S: "s", T: "t", U: "u", V: "v", X: "x", Y: "y", Z: "z",
        "\u0401": "yo", "\u0451": "yo", "\u0410": "a", "\u0430": "a", "\u0411": "b", "\u0431": "b",
        "\u0412": "v", "\u0432": "v", "\u0413": "g", "\u0433": "g", "\u0414": "d", "\u0434": "d",
        "\u0415": "e", "\u0435": "e", "\u0416": "j", "\u0436": "j", "\u0417": "z", "\u0437": "z",
        "\u0418": "i", "\u0438": "i", "\u0419": "y", "\u0439": "y", "\u041a": "k", "\u043a": "k",
        "\u041b": "l", "\u043b": "l", "\u041c": "m", "\u043c": "m", "\u041d": "n", "\u043d": "n",
        "\u041e": "o", "\u043e": "o", "\u041f": "p", "\u043f": "p", "\u0420": "r", "\u0440": "r",
        "\u0421": "s", "\u0441": "s", "\u0422": "t", "\u0442": "t", "\u0423": "u", "\u0443": "u",
        "\u0424": "f", "\u0444": "f", "\u0425": "x", "\u0445": "x", "\u0426": "ts", "\u0446": "ts",
        "\u0427": "ch", "\u0447": "ch", "\u0428": "sh", "\u0448": "sh", "\u0429": "sh", "\u0449": "sh",
        "\u042a": "", "\u044a": "", "\u042b": "i", "\u044b": "i", "\u042c": "", "\u044c": "",
        "\u042d": "e", "\u044d": "e", "\u042e": "yu", "\u044e": "yu", "\u042f": "ya", "\u044f": "ya",
    };

    return Array.from(normalized).map((char) => map[char] ?? char).join("");
}

function slugifyTitle(title, bodyText) {
    const source = String(title || "").trim() || String(bodyText || "").trim() || "untitled-post";
    const latin = transliterate(source);
    const deAccented = latin.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    const compact = deAccented
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

    const maxLength = 52;
    const shortened = compact.length <= maxLength ? compact : compact.slice(0, maxLength).replace(/-+$/g, "");
    return shortened || "untitled-post";
}

async function resolveUniqueSlug(baseSlug) {
    let candidate = baseSlug;
    let suffix = 2;

    while (true) {
        const candidatePath = path.join(BLOG_DIR, candidate);
        try {
            await fs.access(candidatePath);
            candidate = `${baseSlug}-${suffix}`;
            suffix += 1;
        } catch {
            return candidate;
        }
    }
}

const LOCAL_TIMEZONE = "Asia/Tashkent";

function getLocalDateParts(date) {
    const fmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: LOCAL_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
    const parts = {};
    for (const { type, value } of fmt.formatToParts(date)) {
        parts[type] = value;
    }
    return parts;
}

function formatHumanDate(date) {
    const months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ];
    const p = getLocalDateParts(date);
    const monthIndex = parseInt(p.month, 10) - 1;
    return `${parseInt(p.day, 10)} ${months[monthIndex]}, ${p.year} · ${p.hour}:${p.minute}`;
}

function formatLocalIsoDate(date) {
    const p = getLocalDateParts(date);
    return `${p.year}-${p.month}-${p.day}`;
}

function normalizeBodyHtml(bodyHtml, bodyText) {
    const cleanHtml = String(bodyHtml || "").trim();
    if (cleanHtml) return cleanHtml;

    const text = stripTags(bodyText);
    return text ? `<p>${escapeHtml(text)}</p>` : "<p></p>";
}

function buildPostHtml({ title, bodyHtml, publishedDate }) {
    const safeTitle = escapeHtml(title);
    const safeDescription = escapeHtml(stripTags(bodyHtml).slice(0, 220));

    return `<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${safeTitle}</title>
    <meta name="author" content="Bekzod">
    <meta property="og:site_name" content="Tutorbek's Blog"/>
    <meta property="og:description" content="${safeDescription}">
    <link rel="preconnect" href="https://fonts.googleapis.com"/>
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
    <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&family=Inter:wght@200;300;400;500;600&display=swap" rel="stylesheet"/>
    <meta name="msapplication-TileColor" content="#da532c">
    <meta name="theme-color" content="#ffffff">
    <link rel="icon" type="image/png" href="/static/assets/images/icons/javaicon.png"/>
    <link rel="stylesheet" href="/site.css"/>
</head>

<body>

<div class="progress-bar">
    <div class="bar"></div>
</div>

<main class="blog-wrap blog-wrap--post">
    <div id="archive">
        <div class="back-row">
            <a href="../index.html" class="text-gray-600 hover:text-gray-800 transition-colors inline-block text-lg" aria-label="Back">
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-6 h-6">
                <line x1="19" y1="12" x2="5" y2="12"></line>
                <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
</a>
        </div>
    </div>

    <div class="article-header">
        <h1 class="title">${safeTitle}</h1>
        <div class="date">
            <span>${publishedDate}</span>
        </div>
    </div>

    <article class="content">
        ${bodyHtml}
    </article>
</main>

<script>
    var progressBar = document.querySelector('.progress-bar .bar');
    if (progressBar) {
        window.addEventListener('scroll', function () {
            var pixelScrolled = window.scrollY;
            var viewportHeight = window.innerHeight;
            var totalHeight = document.body.scrollHeight;
            progressBar.style.width = (pixelScrolled / (totalHeight - viewportHeight)) * 100 + '%';
        });
    }
</script>
<script src="/site.js" defer></script>
</body>

</html>
`;
}

async function readPosts() {
    try {
        const raw = await fs.readFile(POSTS_JSON_PATH, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function writePosts(posts) {
    await fs.writeFile(POSTS_JSON_PATH, `${JSON.stringify(posts, null, 2)}\n`, "utf8");
}

let telegramConfigCache = null;
const TELEGRAM_FOOTER = "@tutorbek";
const TELEGRAM_MAX_TEXT = 4096;

function deriveTelegramCryptoKey(authConfig) {
    const seed = `${authConfig.salt}:${authConfig.hash}:${authConfig.iterations}`;
    return crypto.createHash("sha256").update(seed).digest();
}

function decryptTelegramConfig(encryptedConfig, authConfig) {
    const iv = Buffer.from(encryptedConfig.iv, "hex");
    const tag = Buffer.from(encryptedConfig.tag, "hex");
    const data = Buffer.from(encryptedConfig.data, "hex");
    const key = deriveTelegramCryptoKey(authConfig);

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    return JSON.parse(plaintext);
}

async function loadTelegramConfig() {
    if (telegramConfigCache) return telegramConfigCache;

    const authConfig = await loadAuthConfig();
    const raw = await fs.readFile(TELEGRAM_CONFIG_PATH, "utf8");
    const encrypted = JSON.parse(raw);
    const decrypted = decryptTelegramConfig(encrypted, authConfig);

    telegramConfigCache = {
        token: String(decrypted.token || "").trim(),
        chatId: String(decrypted.chatId || "").trim(),
        botUsername: String(decrypted.botUsername || "").trim(),
    };

    if (!telegramConfigCache.token || !telegramConfigCache.chatId) {
        throw new Error("Telegram config not complete");
    }

    return telegramConfigCache;
}

function normalizeTelegramLink(rawHref) {
    const href = String(rawHref || "").trim();
    if (!href) return "";
    if (/^(javascript|data):/i.test(href)) return "";
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith("//")) return `https:${href}`;
    if (href.startsWith("/")) return `${PUBLIC_BASE_URL}${href}`;
    return `${PUBLIC_BASE_URL}/${href.replace(/^\/+/, "")}`;
}

function extractYouTubeWatchUrl(rawUrl) {
    const urlText = String(rawUrl || "").trim();
    if (!urlText) return "";

    let parsed;
    try {
        parsed = new URL(urlText, PUBLIC_BASE_URL);
    } catch {
        return "";
    }

    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    let videoId = "";

    if (host === "youtu.be") {
        videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
    } else if (host.endsWith("youtube.com")) {
        if (parsed.pathname === "/watch") {
            videoId = parsed.searchParams.get("v") || "";
        } else {
            const segments = parsed.pathname.split("/").filter(Boolean);
            if (segments[0] === "embed" || segments[0] === "shorts" || segments[0] === "live") {
                videoId = segments[1] || "";
            }
        }
    }

    if (!videoId) return "";
    return `https://www.youtube.com/watch?v=${videoId}`;
}

function extractPostForEdit(html) {
    const input = String(html || "");
    const titleMatch = input.match(/<h1[^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i);
    const articleMatch = input.match(/<article[^>]*class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/article>/i);

    return {
        title: decodeMetaValue(titleMatch ? titleMatch[1] : ""),
        bodyHtml: String(articleMatch ? articleMatch[1] : "").trim(),
    };
}

function extractPostDateFromHtml(html) {
    const input = String(html || "");
    const dateMatch = input.match(/<div[^>]*class=["'][^"']*date[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/div>/i);
    return decodeMetaValue(dateMatch ? dateMatch[1] : "");
}

function htmlToTelegramRichText(html) {
    const input = String(html || "");
    const tokens = input.match(/<[^>]+>|[^<]+/g) || [];
    let out = "";
    let skipBookmarkAnchorText = false;

    const pushBreak = (count = 1) => {
        const next = "\n".repeat(count);
        if (out.endsWith(next)) return;
        out += next;
    };

    for (const token of tokens) {
        if (!token.startsWith("<")) {
            if (skipBookmarkAnchorText) continue;
            out += escapeHtml(decodeHtmlEntities(token));
            continue;
        }

        const close = /^<\s*\//.test(token);
        const nameMatch = token.match(/^<\/?\s*([a-z0-9]+)/i);
        if (!nameMatch) continue;
        const tag = nameMatch[1].toLowerCase();

        if (skipBookmarkAnchorText) {
            if (tag === "a" && close) {
                skipBookmarkAnchorText = false;
            }
            continue;
        }

        if (tag === "br") {
            pushBreak(1);
            continue;
        }

        if (tag === "b" || tag === "strong") {
            out += close ? "</b>" : "<b>";
            continue;
        }

        if (tag === "i" || tag === "em") {
            out += close ? "</i>" : "<i>";
            continue;
        }

        if (tag === "a") {
            if (close) {
                out += "</a>";
            } else {
                const hrefMatch = token.match(/\bhref=["']([^"']+)["']/i);
                const href = normalizeTelegramLink(hrefMatch ? hrefMatch[1] : "");
                if (!href) continue;

                const classMatch = token.match(/\bclass=["']([^"']+)["']/i);
                const className = String(classMatch ? classMatch[1] : "");
                if (/(^|\s)social-bookmark(\s|$)/i.test(className)) {
                    out += `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`;
                    skipBookmarkAnchorText = true;
                } else {
                    out += `<a href="${escapeHtml(href)}">`;
                }
            }
            continue;
        }

        if (tag === "iframe" && !close) {
            const srcMatch = token.match(/\bsrc=["']([^"']+)["']/i);
            const sourceMatch = token.match(/\bdata-source-url=["']([^"']+)["']/i);
            const sourceUrl = sourceMatch ? sourceMatch[1] : "";
            const watchUrl = extractYouTubeWatchUrl(sourceUrl || (srcMatch ? srcMatch[1] : ""));
            if (watchUrl) {
                if (out && !out.endsWith("\n")) pushBreak(1);
                out += `<a href="${escapeHtml(watchUrl)}">${escapeHtml(watchUrl)}</a>`;
                pushBreak(1);
            }
            continue;
        }

        if (["p", "div", "section", "article", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
            if (close) pushBreak(2);
            continue;
        }

        if (tag === "li") {
            if (!close) {
                if (out && !out.endsWith("\n")) pushBreak(1);
                out += "• ";
            } else {
                pushBreak(1);
            }
            continue;
        }

        if (tag === "ul" || tag === "ol") {
            if (close) pushBreak(1);
        }
    }

    return out.replace(/\n{3,}/g, "\n\n").trim();
}

function buildTelegramPostContent({ title, slug, bodyHtml }) {
    const safeTitle = `<b>${escapeHtml(title || "Untitled")}</b>`;
    const richBody = htmlToTelegramRichText(bodyHtml || "");
    const plainBody = richBody.replace(/<[^>]+>/g, "");
    const postHref = `${PUBLIC_BASE_URL}/blog/${slug}/`;
    const postVisibleUrl = `tutorbek.com/blog/${slug}/`;

    const fullText = `${safeTitle}\n\n${richBody}\n\n${TELEGRAM_FOOTER}`;
    if (fullText.length <= TELEGRAM_MAX_TEXT) {
        return { text: fullText, usedReadMore: false };
    }

    const readMoreLine = `<a href="${postHref}">${postVisibleUrl}</a>`;
    const suffix = `\n\n${readMoreLine}\n\n${TELEGRAM_FOOTER}`;
    const allowedBodyLength = Math.max(32, TELEGRAM_MAX_TEXT - safeTitle.length - suffix.length - 2);
    const trimmed = `${plainBody.slice(0, allowedBodyLength).trimEnd()}...`;

    return {
        text: `${safeTitle}\n\n${escapeHtml(trimmed)}${suffix}`,
        usedReadMore: true,
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callTelegramApi(token, method, payload) {
    const maxAttempts = 4;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            const data = await response.json().catch(() => ({}));
            if (response.ok && data.ok) {
                return data.result;
            }

            const retryAfter = Number(data?.parameters?.retry_after || 0);
            const canRetry = response.status === 429 || response.status >= 500;
            const err = new Error(data.description || `Telegram ${method} failed`);
            err.statusCode = data.error_code || response.status;

            if (!canRetry || attempt === maxAttempts) {
                err.noRetry = true;
                throw err;
            }

            const waitMs = retryAfter > 0 ? retryAfter * 1000 : 500 * (2 ** (attempt - 1));
            await sleep(waitMs);
        } catch (error) {
            if (error && error.noRetry) throw error;
            lastError = error;
            if (attempt === maxAttempts) break;
            await sleep(500 * (2 ** (attempt - 1)));
        }
    }

    throw lastError || new Error(`Telegram ${method} failed`);
}

async function syncTelegramCreate({ title, slug, bodyHtml }) {
    const config = await loadTelegramConfig();
    const { text } = buildTelegramPostContent({ title, slug, bodyHtml });
    const result = await callTelegramApi(config.token, "sendMessage", {
        chat_id: config.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
    });

    return {
        chatId: config.chatId,
        messageId: result.message_id,
        mode: "text",
        syncedAt: new Date().toISOString(),
    };
}

async function syncTelegramUpdate({ title, slug, bodyHtml, telegramMeta }) {
    const config = await loadTelegramConfig();
    const currentChatId = telegramMeta?.chatId || config.chatId;
    const currentMessageId = telegramMeta?.messageId;

    if (!currentMessageId) {
        return syncTelegramCreate({ title, slug, bodyHtml });
    }

    const { text } = buildTelegramPostContent({ title, slug, bodyHtml });

    try {
        await callTelegramApi(config.token, "editMessageText", {
            chat_id: currentChatId,
            message_id: currentMessageId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: false,
        });

        return {
            chatId: currentChatId,
            messageId: currentMessageId,
            mode: "text",
            syncedAt: new Date().toISOString(),
        };
    } catch (error) {
        const reason = String(error?.message || "").toLowerCase();
        const shouldRecreate = reason.includes("message to edit not found")
            || reason.includes("message can't be edited");

        if (!shouldRecreate) throw error;

        const created = await callTelegramApi(config.token, "sendMessage", {
            chat_id: config.chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: false,
        });

        return {
            chatId: config.chatId,
            messageId: created.message_id,
            mode: "text",
            syncedAt: new Date().toISOString(),
        };
    }
}

async function telegramPreviewHandler(req, res, slugFromQuery = "") {
    try {
        let title = "";
        let bodyHtml = "";
        let slug = String(slugFromQuery || "").trim();

        if (req.method === "GET") {
            if (!isValidSlug(slug)) {
                sendJson(res, 400, { error: "Invalid slug" });
                return;
            }

            const postFilePath = path.join(BLOG_DIR, slug, "index.html");
            const html = await fs.readFile(postFilePath, "utf8");
            const parsed = extractPostForEdit(html);
            title = parsed.title || "";
            bodyHtml = parsed.bodyHtml || "";
        } else {
            const body = await readJsonBody(req);
            const titleInput = String(body.title || "").trim();
            const bodyText = stripTags(body.bodyText || body.bodyHtml || "");
            title = titleInput || bodyText.slice(0, 60) || "Untitled";
            bodyHtml = normalizeBodyHtml(body.bodyHtml, bodyText);
            slug = isValidSlug(body.slug) ? String(body.slug) : slug || slugifyTitle(titleInput, bodyText);
        }

        const preview = buildTelegramPostContent({ title, slug, bodyHtml });
        sendJson(res, 200, {
            ok: true,
            slug,
            text: preview.text,
            usedReadMore: Boolean(preview.usedReadMore),
            length: preview.text.length,
        });
    } catch (error) {
        if (error && error.code === "ENOENT") {
            sendJson(res, 404, { error: "Post topilmadi" });
            return;
        }
        sendJson(res, 500, { error: error.message || "Telegram preview xatoligi" });
    }
}

async function publishPostHandler(req, res) {
    try {
        const body = await readJsonBody(req);
        const sendToTelegram = resolveSendToTelegramFlag(body.sendToTelegram, false);
        const titleInput = String(body.title || "").trim();
        const bodyText = stripTags(body.bodyText || body.bodyHtml || "");
        const title = titleInput || bodyText.slice(0, 60) || "Untitled";

        if (!titleInput && !bodyText) {
            sendJson(res, 400, { error: "Write something before publishing" });
            return;
        }

        const baseSlug = slugifyTitle(titleInput, bodyText);
        const slug = await resolveUniqueSlug(baseSlug);
        const folderPath = path.join(BLOG_DIR, slug);

        const now = new Date();
        const isoDate = formatLocalIsoDate(now);
        const date = now.getDate() + " " + now.toLocaleString("en-US", { month: "long" }) + ", " + now.getFullYear() + " · " + now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });

        const normalizedBody = normalizeBodyHtml(body.bodyHtml, bodyText);

        await fs.mkdir(folderPath, { recursive: true });
        const html = buildPostHtml({
            title,
            bodyHtml: normalizedBody,
            publishedDate: date,
        });
        await fs.writeFile(path.join(folderPath, "index.html"), html, "utf8");

        const posts = await readPosts();
        const createdPost = {
            href: `${slug}/`,
            date,
            isoDate,
            title,
            sendToTelegram,
        };

        if (sendToTelegram) {
            try {
                createdPost.telegram = await syncTelegramCreate({
                    title,
                    slug,
                    bodyHtml: normalizedBody,
                });
            } catch (telegramError) {
                createdPost.telegramError = telegramError.message || "Telegram sync failed";
            }
        }

        posts.unshift(createdPost);
        await writePosts(posts);

        sendJson(res, 201, { ok: true, slug, href: `/blog/${slug}/` });
    } catch (error) {
        sendJson(res, 500, { error: error.message || "Publish failed" });
    }
}

function parseCookies(req) {
    const cookieHeader = req.headers.cookie || "";
    return cookieHeader.split(";").reduce((acc, pair) => {
        const [rawKey, ...rest] = pair.trim().split("=");
        if (!rawKey) return acc;
        acc[rawKey] = decodeURIComponent(rest.join("=") || "");
        return acc;
    }, {});
}

let authConfigCache = null;

async function loadAuthConfig() {
    if (authConfigCache) return authConfigCache;
    const raw = await fs.readFile(AUTH_CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    authConfigCache = cfg;
    return cfg;
}

function hashPassword(password, cfg) {
    return crypto.pbkdf2Sync(password, cfg.salt, cfg.iterations, cfg.keylen, cfg.digest).toString("hex");
}

function safeEqualHex(a, b) {
    const aBuf = Buffer.from(String(a || ""), "hex");
    const bBuf = Buffer.from(String(b || ""), "hex");
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
}

function buildAuthCookieValue(cfg) {
    return crypto.createHash("sha256").update(`${cfg.salt}:${cfg.hash}`).digest("hex");
}

async function isCreatePostAuthorized(req) {
    const cfg = await loadAuthConfig();
    const cookies = parseCookies(req);
    return cookies[AUTH_COOKIE_NAME] === buildAuthCookieValue(cfg);
}

function decodeHtmlEntities(value) {
    return String(value || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function sanitizeFileStem(name) {
    return String(name || "file")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "file";
}

function decodeDataUrl(dataUrl) {
    const match = String(dataUrl || "").match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
        throw new Error("Invalid media payload");
    }
    return {
        mimeType: match[1].toLowerCase(),
        buffer: Buffer.from(match[2], "base64"),
    };
}

function mediaExtensionFromMime(mimeType) {
    const map = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/svg+xml": "svg",
        "application/pdf": "pdf",
        "application/x-pdf": "pdf",
    };
    return map[mimeType] || "";
}

function extensionFromFileName(fileName) {
    const match = String(fileName || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
}

function resolveMediaType(mimeType, fileName) {
    const extFromMime = mediaExtensionFromMime(mimeType);
    if (extFromMime) {
        return {
            ext: extFromMime,
            kind: extFromMime === "pdf" ? "pdf" : "image",
        };
    }

    const ext = extensionFromFileName(fileName);
    const imageExts = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg"]);
    if (ext === "pdf") return { ext: "pdf", kind: "pdf" };
    if (imageExts.has(ext)) return { ext: ext === "jpeg" ? "jpg" : ext, kind: "image" };
    return { ext: "", kind: "" };
}

async function uploadMediaHandler(req, res) {
    try {
        const body = await readJsonBody(req);
        const originalName = String(body.fileName || "upload").trim();
        const decoded = decodeDataUrl(body.dataUrl);
        const resolved = resolveMediaType(decoded.mimeType, originalName);

        if (!resolved.kind) {
            sendJson(res, 400, { error: "Faqat rasm yoki PDF yuklash mumkin" });
            return;
        }

        if (decoded.buffer.length === 0 || decoded.buffer.length > MEDIA_MAX_SIZE_BYTES) {
            sendJson(res, 400, { error: "Fayl hajmi 10MB dan oshmasligi kerak" });
            return;
        }

        await fs.mkdir(MEDIA_DIR, { recursive: true });

        const stem = sanitizeFileStem(originalName.replace(/\.[^./\\]+$/, ""));
        const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const fileName = `${stem}-${unique}.${resolved.ext}`;
        const filePath = path.join(MEDIA_DIR, fileName);

        await fs.writeFile(filePath, decoded.buffer);

        sendJson(res, 201, {
            ok: true,
            kind: resolved.kind,
            fileName,
            url: `/blog/media/${fileName}`,
        });
    } catch (error) {
        sendJson(res, 500, { error: error.message || "Media upload xatoligi" });
    }
}

function safeNextPath(nextPath, fallback = "/blog/createpost") {
    const next = String(nextPath || "").trim();
    if (!next.startsWith("/") || next.startsWith("//")) return fallback;
    return next;
}

function isValidSlug(slug) {
    return /^[a-z0-9-]+$/.test(String(slug || ""));
}

function resolveSendToTelegramFlag(value, fallback = false) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["1", "true", "on", "yes"].includes(normalized)) return true;
        if (["0", "false", "off", "no"].includes(normalized)) return false;
    }
    return Boolean(fallback);
}

function decodeMetaValue(value) {
    return decodeHtmlEntities(String(value || "").trim());
}

function parsePreviewUrl(rawUrl) {
    const urlText = String(rawUrl || "").trim();
    if (!urlText) return null;

    try {
        const urlObj = new URL(urlText);
        if (!["http:", "https:"].includes(urlObj.protocol)) return null;
        return urlObj;
    } catch {
        return null;
    }
}

function isPrivateIpv4(hostname) {
    const match = String(hostname || "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return false;
    const nums = match.slice(1).map(Number);
    if (nums.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false;

    const [a, b] = nums;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
}

function isBlockedPreviewHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    if (!host) return true;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;

    // Reject loopback/link-local/unique-local IPv6 literals only.
    const normalizedIpv6 = host.replace(/^\[|]$/g, "");
    if (normalizedIpv6.includes(":")) {
        if (normalizedIpv6 === "::1" || normalizedIpv6.startsWith("fe80:") || normalizedIpv6.startsWith("fc") || normalizedIpv6.startsWith("fd")) {
            return true;
        }
    }

    return isPrivateIpv4(host);
}

function extractMetaContent(html, attrName, attrValue) {
    const escapedValue = String(attrValue || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`<meta[^>]*${attrName}=["']${escapedValue}["'][^>]*content=["']([^"']+)["'][^>]*>|<meta[^>]*content=["']([^"']+)["'][^>]*${attrName}=["']${escapedValue}["'][^>]*>`, "i");
    const match = String(html || "").match(regex);
    if (!match) return "";
    return decodeMetaValue(match[1] || match[2] || "");
}

function extractTitleTag(html) {
    const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!match) return "";
    return decodeMetaValue(match[1] || "").replace(/\s+/g, " ").trim();
}

function extractFaviconHref(html) {
    const input = String(html || "");
    const iconMatch = input.match(/<link[^>]*rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/i)
        || input.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["'][^"']*icon[^"']*["'][^>]*>/i);
    return decodeMetaValue(iconMatch ? iconMatch[1] : "");
}

function resolveMaybeRelativeUrl(value, baseUrl) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^(javascript|data):/i.test(raw)) return "";

    try {
        return new URL(raw, baseUrl).href;
    } catch {
        return "";
    }
}

async function linkPreviewHandler(req, res) {
    try {
        const body = await readJsonBody(req);
        const inputUrl = parsePreviewUrl(body.url);

        if (!inputUrl) {
            sendJson(res, 400, { error: "Invalid URL" });
            return;
        }

        if (isBlockedPreviewHost(inputUrl.hostname)) {
            sendJson(res, 400, { error: "Blocked host" });
            return;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LINK_PREVIEW_TIMEOUT_MS);

        let response;
        try {
            response = await fetch(inputUrl.href, {
                method: "GET",
                redirect: "follow",
                signal: controller.signal,
                headers: {
                    "User-Agent": "TutorbekLinkPreview/1.0 (+https://tutorbek.com)",
                    Accept: "text/html,application/xhtml+xml",
                },
            });
        } finally {
            clearTimeout(timer);
        }

        if (!response || !response.ok) {
            sendJson(res, 502, { error: "Preview fetch failed" });
            return;
        }

        const finalUrl = parsePreviewUrl(response.url) || inputUrl;
        if (isBlockedPreviewHost(finalUrl.hostname)) {
            sendJson(res, 400, { error: "Blocked redirect host" });
            return;
        }

        const contentType = String(response.headers.get("content-type") || "").toLowerCase();
        if (!contentType.includes("text/html")) {
            sendJson(res, 200, {
                ok: true,
                url: finalUrl.href,
                title: finalUrl.hostname,
                image: "",
                favicon: `${finalUrl.origin}/favicon.ico`,
            });
            return;
        }

        const html = (await response.text()).slice(0, LINK_PREVIEW_MAX_HTML_CHARS);

        const ogTitle = extractMetaContent(html, "property", "og:title") || extractMetaContent(html, "name", "og:title");
        const twTitle = extractMetaContent(html, "name", "twitter:title");
        const pageTitle = extractTitleTag(html);
        const ogImage = extractMetaContent(html, "property", "og:image") || extractMetaContent(html, "name", "og:image");
        const faviconHref = extractFaviconHref(html);

        const title = ogTitle || twTitle || pageTitle || finalUrl.hostname;

        sendJson(res, 200, {
            ok: true,
            url: finalUrl.href,
            title,
            image: resolveMaybeRelativeUrl(ogImage, finalUrl.href),
            favicon: resolveMaybeRelativeUrl(faviconHref, finalUrl.href) || `${finalUrl.origin}/favicon.ico`,
        });
    } catch (error) {
        const message = error && error.name === "AbortError"
            ? "Preview timeout"
            : (error.message || "Preview xatoligi");
        sendJson(res, 500, { error: message });
    }
}

async function upsertPostHandler(req, res, slug) {
    try {
        if (!isValidSlug(slug)) {
            sendJson(res, 400, { error: "Invalid slug" });
            return;
        }

        const body = await readJsonBody(req);
        const titleInput = String(body.title || "").trim();
        const bodyText = stripTags(body.bodyText || body.bodyHtml || "");
        const title = titleInput || bodyText.slice(0, 60) || "Untitled";

        if (!titleInput && !bodyText) {
            sendJson(res, 400, { error: "Write something before publishing" });
            return;
        }

        const oldFolderPath = path.join(BLOG_DIR, slug);
        const oldPostFilePath = path.join(oldFolderPath, "index.html");
        const existingHtml = await fs.readFile(oldPostFilePath, "utf8");
        const posts = await readPosts();
        const postIndex = posts.findIndex((post) => post.href === `${slug}/` || post.href === `${slug}/index.html`);
        const preservedDate = postIndex >= 0 ? posts[postIndex].date : extractPostDateFromHtml(existingHtml) || formatHumanDate(new Date());
        const existingTelegramMeta = postIndex >= 0 ? posts[postIndex].telegram : null;
        const currentSendToTelegram = postIndex >= 0 ? Boolean(posts[postIndex].sendToTelegram) : false;
        const hasExplicitSendFlag = Object.prototype.hasOwnProperty.call(body, "sendToTelegram");
        const sendToTelegram = hasExplicitSendFlag
            ? resolveSendToTelegramFlag(body.sendToTelegram, currentSendToTelegram)
            : currentSendToTelegram;

        const desiredSlug = slugifyTitle(titleInput, bodyText);
        let nextSlug = slug;

        if (desiredSlug !== slug) {
            nextSlug = await resolveUniqueSlug(desiredSlug);
            await fs.rename(oldFolderPath, path.join(BLOG_DIR, nextSlug));
        }

        const normalizedBody = normalizeBodyHtml(body.bodyHtml, bodyText);
        const html = buildPostHtml({
            title,
            bodyHtml: normalizedBody,
            publishedDate: preservedDate,
        });

        const nextPostFilePath = path.join(BLOG_DIR, nextSlug, "index.html");
        await fs.writeFile(nextPostFilePath, html, "utf8");

        let syncedTelegramMeta = existingTelegramMeta;
        let telegramError = "";

        if (sendToTelegram) {
            try {
                syncedTelegramMeta = await syncTelegramUpdate({
                    title,
                    slug: nextSlug,
                    bodyHtml: normalizedBody,
                    telegramMeta: existingTelegramMeta,
                });
            } catch (syncError) {
                telegramError = syncError.message || "Telegram update failed";
            }
        }

        if (postIndex >= 0) {
            posts[postIndex].title = title;
            posts[postIndex].href = `${nextSlug}/`;
            posts[postIndex].sendToTelegram = sendToTelegram;
            posts[postIndex].telegram = syncedTelegramMeta || null;
            if (sendToTelegram && telegramError) {
                posts[postIndex].telegramError = telegramError;
            } else {
                delete posts[postIndex].telegramError;
            }
            await writePosts(posts);
        }

        sendJson(res, 200, { ok: true, slug: nextSlug, href: `/blog/${nextSlug}/` });
    } catch (error) {
        if (error && error.code === "ENOENT") {
            sendJson(res, 404, { error: "Post topilmadi" });
            return;
        }
        sendJson(res, 500, { error: error.message || "Update failed" });
    }
}

async function deletePostHandler(res, slug) {
    try {
        if (!isValidSlug(slug)) {
            sendJson(res, 400, { error: "Invalid slug" });
            return;
        }

        const folderPath = path.join(BLOG_DIR, slug);
        await fs.rm(folderPath, { recursive: true, force: false });

        const posts = await readPosts();
        const nextPosts = posts.filter((post) => post.href !== `${slug}/` && post.href !== `${slug}/index.html`);
        await writePosts(nextPosts);

        // Telegram side is intentionally untouched.
        sendJson(res, 200, { ok: true, href: "/blog/" });
    } catch (error) {
        if (error && error.code === "ENOENT") {
            sendJson(res, 404, { error: "Post topilmadi" });
            return;
        }
        sendJson(res, 500, { error: error.message || "Delete failed" });
    }
}

async function serveStatic(req, res) {
    const reqPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const relativePath = reqPath === "/" ? "/index.html" : reqPath;
    const candidatePath = path.normalize(path.join(ROOT_DIR, relativePath));

    if (!candidatePath.startsWith(ROOT_DIR)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
    }

    let filePath = candidatePath;
    try {
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
            filePath = path.join(filePath, "index.html");
        }
    } catch {
        if (!path.extname(filePath)) {
            const htmlFallback = `${filePath}.html`;
            try {
                const htmlStat = await fs.stat(htmlFallback);
                if (htmlStat.isFile()) {
                    filePath = htmlFallback;
                } else {
                    filePath = path.join(filePath, "index.html");
                }
            } catch {
                filePath = path.join(filePath, "index.html");
            }
        }
    }

    try {
        const ext = path.extname(filePath).toLowerCase();
        const data = await fs.readFile(filePath);
        res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" });
        res.end(data);
    } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
    }
}

function renderLoginPage(nextPath, hasError = false) {
    const safeNext = escapeHtml(safeNextPath(nextPath));
    console.log('loginga kirdi serverjs');
    return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Login</title>
  <style>
    body { font-family: Inter, -apple-system, sans-serif; background: #f8fafc; margin: 0; }
    .card { max-width: 420px; margin: 14vh auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0 0 16px; color: #475569; }
    input { width: 100%; padding: 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 15px; box-sizing: border-box; }
    button { margin-top: 12px; width: 100%; padding: 12px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; font-size: 14px; cursor: pointer; }
    .status { margin-top: 10px; color: #dc2626; min-height: 20px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Login</h1>
    <p>Enter password to continue.</p>
    <form method="POST" action="/auth/login">
      <input type="hidden" name="next" value="${safeNext}" />
      <input name="password" type="password" placeholder="Parol" autocomplete="current-password" required />
      <button type="submit">Kirish</button>
    </form>
    <div class="status">${hasError ? "Parol noto'g'ri" : ""}</div>
  </div>
</body>
</html>`;
}

async function getAuthPayload(req) {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();

    if (contentType.includes("application/json")) {
        const body = await readJsonBody(req);
        return {
            password: String(body.password || "").trim(),
            next: safeNextPath(body.next || "/blog/createpost"),
        };
    }

    const raw = await readTextBody(req);
    const params = new URLSearchParams(raw);
    return {
        password: String(params.get("password") || "").trim(),
        next: safeNextPath(params.get("next") || "/blog/createpost"),
    };
}

const ALLOWED_ORIGINS = [
    "https://tutorbek.github.io", // <-- GitHub Pages URL ingizni yozing
];

const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, "http://localhost");
    const pathname = urlObj.pathname;
    const postApiMatch = pathname.match(/^\/api\/posts\/([a-z0-9-]+)$/);

    // CORS — GitHub Pages dan kelgan so'rovlar uchun
    const origin = req.headers.origin || "";
    if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    }

    // OPTIONS preflight so'rovlarini hal qilish
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method === "GET" && pathname === "/api/auth/status") {
        const authenticated = await isCreatePostAuthorized(req).catch(() => false);
        sendJson(res, 200, { authenticated });
        return;
    }

    if (req.method === "GET" && pathname === "/login") {
        const authorized = await isCreatePostAuthorized(req).catch(() => false);
        if (authorized) {
            res.writeHead(302, { Location: safeNextPath(urlObj.searchParams.get("next") || "/blog/createpost") });
            res.end();
            return;
        }

        const hasError = urlObj.searchParams.get("auth") === "failed";
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
        });
        res.end(renderLoginPage(urlObj.searchParams.get("next") || "/blog/createpost", hasError));
        return;
    }

    if (req.method === "POST" && (pathname === "/auth/login" || pathname === "/auth/createpost")) {
        try {
            const cfg = await loadAuthConfig();
            const payload = await getAuthPayload(req);
            const givenHash = hashPassword(payload.password, cfg);
            const wantsJson = String(req.headers.accept || "").includes("application/json")
                || String(req.headers["content-type"] || "").includes("application/json");

            if (!safeEqualHex(givenHash, cfg.hash)) {
                if (wantsJson) {
                    sendJson(res, 401, { error: "Parol noto'g'ri" });
                } else {
                    const next = encodeURIComponent(payload.next || "/blog/createpost");
                    res.writeHead(302, { Location: `/login?auth=failed&next=${next}` });
                    res.end();
                }
                return;
            }

            const cookieValue = buildAuthCookieValue(cfg);
            const cookieHeader = `${AUTH_COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=86400`;
            if (wantsJson) {
                res.writeHead(200, {
                    "Content-Type": "application/json; charset=utf-8",
                    "Set-Cookie": cookieHeader,
                    "Cache-Control": "no-store",
                });
                res.end(JSON.stringify({ ok: true, next: payload.next }));
            } else {
                res.writeHead(302, {
                    "Set-Cookie": cookieHeader,
                    Location: payload.next,
                    "Cache-Control": "no-store",
                });
                res.end();
            }
            return;
        } catch (error) {
            sendJson(res, 500, { error: error.message || "Auth xatoligi" });
            return;
        }
    }

    if (req.method === "GET" && postApiMatch) {
        const authorized = await isCreatePostAuthorized(req).catch(() => false);
        if (!authorized) {
            sendJson(res, 401, { error: "Unauthorized" });
            return;
        }

        try {
            const slug = postApiMatch[1];
            const postFilePath = path.join(BLOG_DIR, slug, "index.html");
            const html = await fs.readFile(postFilePath, "utf8");
            const post = extractPostForEdit(html);
            const posts = await readPosts();
            const postMeta = posts.find((item) => item.href === `${slug}/` || item.href === `${slug}/index.html`) || {};
            sendJson(res, 200, {
                ok: true,
                slug,
                ...post,
                sendToTelegram: Boolean(postMeta.sendToTelegram),
            });
        } catch (error) {
            if (error && error.code === "ENOENT") {
                sendJson(res, 404, { error: "Post topilmadi" });
                return;
            }
            sendJson(res, 500, { error: error.message || "Postni o'qishda xatolik" });
        }
        return;
    }

    if (req.method === "PUT" && postApiMatch) {
        const authorized = await isCreatePostAuthorized(req).catch(() => false);
        if (!authorized) {
            sendJson(res, 401, { error: "Unauthorized" });
            return;
        }

        await upsertPostHandler(req, res, postApiMatch[1]);
        return;
    }

    if (req.method === "DELETE" && postApiMatch) {
        const authorized = await isCreatePostAuthorized(req).catch(() => false);
        if (!authorized) {
            sendJson(res, 401, { error: "Unauthorized" });
            return;
        }

        await deletePostHandler(res, postApiMatch[1]);
        return;
    }

    if (req.method === "GET" && (pathname === "/blog/createpost" || pathname === "/blog/createpost/")) {
        const authorized = await isCreatePostAuthorized(req).catch(() => false);
        if (!authorized) {
            const next = encodeURIComponent(pathname + urlObj.search);
            res.writeHead(302, { Location: `/login?next=${next}` });
            res.end();
            return;
        }

        req.url = "/blog/createpost.html" + (urlObj.search || "");
    }

    if ((req.method === "GET" || req.method === "POST") && pathname === "/api/telegram/preview") {
        const authorized = await isCreatePostAuthorized(req).catch(() => false);
        if (!authorized) {
            sendJson(res, 401, { error: "Unauthorized" });
            return;
        }

        await telegramPreviewHandler(req, res, urlObj.searchParams.get("slug") || "");
        return;
    }

    if (req.method === "POST" && pathname === "/api/link-preview") {
        const authorized = await isCreatePostAuthorized(req).catch(() => false);
        if (!authorized) {
            sendJson(res, 401, { error: "Unauthorized" });
            return;
        }

        await linkPreviewHandler(req, res);
        return;
    }

    if (req.method === "POST" && pathname === "/api/media/upload") {
        const authorized = await isCreatePostAuthorized(req).catch(() => false);
        if (!authorized) {
            sendJson(res, 401, { error: "Avval /login da parol kiriting" });
            return;
        }

        await uploadMediaHandler(req, res);
        return;
    }

    if (req.method === "POST" && pathname === "/api/publish") {
        const authorized = await isCreatePostAuthorized(req).catch(() => false);
        if (!authorized) {
            sendJson(res, 401, { error: "Avval /login da parol kiriting" });
            return;
        }

        await publishPostHandler(req, res);
        return;
    }

    if (req.method === "GET" && pathname === "/api/publish") {
        res.writeHead(302, { Location: "/blog/createpost" });
        res.end();
        return;
    }

    if (req.method === "GET" && pathname === "/tools.html") {
        res.writeHead(302, { Location: "/tools" + (urlObj.search || "") });
        res.end();
        return;
    }

    if (req.method === "GET" && pathname.endsWith("/index.html")) {
        const cleanPath = pathname.replace(/index\.html$/, "");
        res.writeHead(302, { Location: cleanPath || "/" });
        res.end();
        return;
    }

    await serveStatic(req, res);
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

