(function () {
    function fallbackCopyText(text) {
        var textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.top = "-9999px";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);

        var copied = document.execCommand("copy");
        document.body.removeChild(textarea);

        return copied;
    }

    function copyText(text) {
        if (fallbackCopyText(text)) {
            return Promise.resolve();
        }

        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text);
        }

        return Promise.reject(new Error("Copy failed"));
    }

    function setButtonState(button, text, className) {
        button.textContent = text;
        button.classList.toggle("is-copied", className === "is-copied");
        button.classList.toggle("is-selected", className === "is-selected");
        button.classList.toggle("is-failed", className === "is-failed");
    }

    function selectCodeText(code) {
        var selection = window.getSelection();
        var range = document.createRange();

        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    function enhanceCodeBlocks() {
        var codeBlocks = document.querySelectorAll("main#content pre > code");

        codeBlocks.forEach(function (code) {
            var pre = code.parentElement;

            if (!pre || pre.parentElement.classList.contains("code-block")) {
                return;
            }

            var wrapper = document.createElement("div");
            wrapper.className = "code-block";
            pre.parentNode.insertBefore(wrapper, pre);
            wrapper.appendChild(pre);

            var button = document.createElement("button");
            button.className = "code-copy-button";
            button.type = "button";
            button.setAttribute("aria-label", "复制代码");
            button.textContent = "复制";
            wrapper.appendChild(button);

            var resetTimer = null;

            button.addEventListener("click", function () {
                clearTimeout(resetTimer);

                copyText(code.innerText || code.textContent || "").then(function () {
                    setButtonState(button, "已复制", "is-copied");
                    resetTimer = setTimeout(function () {
                        setButtonState(button, "复制", "");
                    }, 1600);
                }).catch(function () {
                    try {
                        selectCodeText(code);
                        setButtonState(button, "已选中", "is-selected");
                        resetTimer = setTimeout(function () {
                            setButtonState(button, "复制", "");
                        }, 1600);
                    } catch (error) {
                        setButtonState(button, "失败", "is-failed");
                        resetTimer = setTimeout(function () {
                            setButtonState(button, "复制", "");
                        }, 1600);
                    }
                });
            });
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", enhanceCodeBlocks);
    } else {
        enhanceCodeBlocks();
    }
}());
