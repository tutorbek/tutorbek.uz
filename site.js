// Shared scripts for tutorbek.com

(function setupPostModal() {
    const modal = document.getElementById("postModal");
    if (!modal) return;

    const modalTitle = document.getElementById("postModalTitle");
    const modalDate = document.getElementById("postModalDate");
    const modalBody = document.getElementById("postModalBody");
    const modalClose = document.getElementById("postModalClose");

    const openModal = (title, date, body) => {
        modalTitle.textContent = title || "Untitled";
        modalDate.textContent = date || "";
        modalBody.innerHTML = body || "";
        modal.classList.add("open");
        document.body.classList.add("modal-open");
    };

    const closeModal = () => {
        modal.classList.remove("open");
        document.body.classList.remove("modal-open");
    };

    modalClose?.addEventListener("click", closeModal);
    modal.addEventListener("click", (event) => {
        if (event.target === modal) {
            closeModal();
        }
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && modal.classList.contains("open")) {
            closeModal();
        }
    });

    window.PostModal = { open: openModal, close: closeModal };
})();

(function setupPostEditButton() {
    const pathMatch = window.location.pathname.match(/^\/blog\/([a-z0-9-]+)\/?$/);
    if (!pathMatch) return;

    const slug = pathMatch[1];
    if (slug === "createpost" || slug === "index") return;

    const backRow = document.querySelector("#archive .back-row");
    if (!backRow) return;

    const askDeleteConfirmation = (() => {
        let modal = null;
        let confirmBtn = null;
        let cancelBtn = null;
        let pendingResolve = null;

        const close = (result) => {
            if (!modal) return;
            modal.classList.remove("open");
            document.body.classList.remove("modal-open");
            if (pendingResolve) {
                pendingResolve(Boolean(result));
                pendingResolve = null;
            }
        };

        const ensureModal = () => {
            if (modal) return;

            modal = document.createElement("div");
            modal.className = "delete-confirm-modal";
            modal.innerHTML = `
                <div class="delete-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="deleteConfirmTitle">
                    <h3 id="deleteConfirmTitle">Postni o'chirish</h3>
                    <p>Bu post saytdan o'chadi. Telegramdagi post o'chmaydi.</p>
                    <div class="delete-confirm-actions">
                        <button type="button" class="delete-confirm-cancel">Bekor qilish</button>
                        <button type="button" class="delete-confirm-ok">Ha, o'chiraman</button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            confirmBtn = modal.querySelector(".delete-confirm-ok");
            cancelBtn = modal.querySelector(".delete-confirm-cancel");

            confirmBtn?.addEventListener("click", () => close(true));
            cancelBtn?.addEventListener("click", () => close(false));
            modal.addEventListener("click", (event) => {
                if (event.target === modal) close(false);
            });

            document.addEventListener("keydown", (event) => {
                if (event.key === "Escape" && modal.classList.contains("open")) {
                    close(false);
                }
            });
        };

        return () => {
            ensureModal();
            modal.classList.add("open");
            document.body.classList.add("modal-open");
            return new Promise((resolve) => {
                pendingResolve = resolve;
            });
        };
    })();

    fetch("/api/auth/status", { credentials: "same-origin" })
        .then((response) => response.ok ? response.json() : { authenticated: false })
        .then((payload) => {
            if (!payload.authenticated) return;

            backRow.classList.add("back-row--with-edit");

            const actions = document.createElement("div");
            actions.className = "post-admin-actions";

            const editLink = document.createElement("a");
            editLink.className = "edit-post-btn";
            editLink.href = `/blog/createpost?slug=${encodeURIComponent(slug)}`;
            editLink.textContent = "Edit";
            actions.appendChild(editLink);

            const deleteBtn = document.createElement("button");
            deleteBtn.className = "delete-post-btn";
            deleteBtn.type = "button";
            deleteBtn.textContent = "Delete";
            deleteBtn.addEventListener("click", async () => {
                const ok = await askDeleteConfirmation();
                if (!ok) return;

                deleteBtn.disabled = true;
                deleteBtn.textContent = "Deleting...";

                try {
                    const response = await fetch(`/api/posts/${encodeURIComponent(slug)}`, {
                        method: "DELETE",
                        credentials: "same-origin",
                    });
                    const payload = await response.json().catch(() => ({}));
                    if (!response.ok) {
                        throw new Error(payload.error || "Delete failed");
                    }

                    window.location.assign(payload.href || "/blog/");
                } catch (error) {
                    window.alert("Error: " + (error.message || "Delete failed"));
                    deleteBtn.disabled = false;
                    deleteBtn.textContent = "Delete";
                }
            });
            actions.appendChild(deleteBtn);

            backRow.appendChild(actions);
        })
        .catch(() => {
            // Ignore auth status errors on public pages
        });
})();

(function setupSocialLinkEmbeds() {
    const article = document.querySelector("article.content");
    if (!article) return;

    const parseUrl = (value) => {
        try {
            return new URL(value);
        } catch {
            return null;
        }
    };

    const normalizeHost = (host) => String(host || "").toLowerCase().replace(/^www\./, "");

    const isStandaloneParagraph = (paragraph) => {
        if (!paragraph || paragraph.tagName !== "P") return false;
        const text = paragraph.textContent.trim();
        if (!text) return false;
        if (paragraph.childElementCount === 0) return true;
        if (paragraph.childElementCount === 1 && paragraph.firstElementChild?.tagName === "A") {
            return text === paragraph.firstElementChild.textContent.trim();
        }
        return false;
    };

    const extractStandaloneUrl = (paragraph) => {
        const anchor = paragraph.querySelector("a[href]");
        if (anchor) {
            return { url: anchor.href, text: anchor.textContent.trim() || anchor.href };
        }

        const raw = paragraph.textContent.trim();
        const match = raw.match(/https?:\/\/[^\s]+/i);
        if (!match) return null;
        const clean = match[0].replace(/[),.;!?]+$/, "");
        if (raw !== match[0] && raw !== clean) return null;
        return { url: clean, text: clean };
    };

    const getYouTubeEmbedUrl = (urlObj) => {
        const host = normalizeHost(urlObj.hostname);
        let videoId = "";

        if (host === "youtu.be") {
            videoId = urlObj.pathname.split("/").filter(Boolean)[0] || "";
        } else if (host.endsWith("youtube.com")) {
            if (urlObj.pathname === "/watch") {
                videoId = urlObj.searchParams.get("v") || "";
            } else {
                const segments = urlObj.pathname.split("/").filter(Boolean);
                if (segments[0] === "shorts" || segments[0] === "embed" || segments[0] === "live") {
                    videoId = segments[1] || "";
                }
            }
        }

        if (!videoId) return "";
        return `https://www.youtube.com/embed/${videoId}`;
    };

    const createEmbedWrapper = (src, title) => {
        const wrapper = document.createElement("div");
        wrapper.className = "social-embed social-embed--video";

        const frame = document.createElement("iframe");
        frame.src = src;
        frame.loading = "lazy";
        frame.referrerPolicy = "strict-origin-when-cross-origin";
        frame.allowFullscreen = true;
        frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
        frame.title = title;

        wrapper.appendChild(frame);
        return wrapper;
    };

    const createBookmark = (urlObj, anchorText) => {
        const wrapper = document.createElement("div");
        wrapper.className = "social-embed social-embed--bookmark";

        const card = document.createElement("a");
        card.className = "social-bookmark";
        card.href = urlObj.href;
        card.target = "_blank";
        card.rel = "noopener noreferrer";

        const title = document.createElement("span");
        title.className = "social-bookmark__title";
        title.textContent = (anchorText || "").trim() || "Link";

        const row = document.createElement("span");
        row.className = "social-bookmark__row";

        const icon = document.createElement("img");
        icon.className = "social-bookmark__icon";
        icon.alt = "";
        icon.loading = "lazy";
        icon.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(urlObj.hostname)}&sz=64`;

        const meta = document.createElement("span");
        meta.className = "social-bookmark__meta";
        meta.textContent = urlObj.href;

        row.appendChild(icon);
        row.appendChild(meta);
        card.appendChild(title);
        card.appendChild(row);
        wrapper.appendChild(card);
        return wrapper;
    };

    Array.from(article.querySelectorAll("p")).forEach((paragraph) => {
        if (!isStandaloneParagraph(paragraph)) return;

        const extracted = extractStandaloneUrl(paragraph);
        if (!extracted) return;

        const urlObj = parseUrl(extracted.url);
        if (!urlObj) return;

        const youtubeSrc = getYouTubeEmbedUrl(urlObj);
        if (youtubeSrc) {
            paragraph.replaceWith(createEmbedWrapper(youtubeSrc, "YouTube embed"));
            return;
        }

        paragraph.replaceWith(createBookmark(urlObj, extracted.text));
    });
})();
