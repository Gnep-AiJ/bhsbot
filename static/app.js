(() => {
  const escapeHtml = (value) => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  document.querySelectorAll("[data-confirm]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  });

  const openDialog = (dialog) => {
    if (!dialog?.showModal) return false;
    dialog.showModal();
    document.body.classList.add("has-dialog");
    return true;
  };
  const syncDialogState = () => {
    if (!document.querySelector("dialog[open]")) document.body.classList.remove("has-dialog");
  };
  document.querySelectorAll("[data-open-dialog]").forEach((trigger) => {
    trigger.addEventListener("click", (event) => {
      const dialog = document.getElementById(trigger.dataset.openDialog);
      if (openDialog(dialog)) event.preventDefault();
    });
  });
  document.querySelectorAll(".app-dialog").forEach((dialog) => {
    dialog.addEventListener("close", syncDialogState);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => dialog.close());
    });
  });

  const syncViewportHeight = () => {
    const viewport = window.visualViewport;
    const height = viewport?.height || window.innerHeight;
    document.documentElement.style.setProperty("--app-viewport-height", `${Math.round(height)}px`);
    const keyboardVisible = Boolean(viewport && window.innerHeight - viewport.height > 120);
    document.body.classList.toggle("keyboard-open", keyboardVisible);
  };
  syncViewportHeight();
  window.visualViewport?.addEventListener("resize", syncViewportHeight);
  window.addEventListener("resize", syncViewportHeight);
  document.addEventListener("focusin", (event) => {
    if (event.target.matches("input, textarea, select")) document.body.classList.add("input-focused");
  });
  document.addEventListener("focusout", () => {
    window.setTimeout(() => {
      if (!document.activeElement?.matches("input, textarea, select")) {
        document.body.classList.remove("input-focused");
      }
    }, 80);
  });

  const confirmationDialog = document.querySelector("#confirmActionDialog");
  let formAwaitingConfirmation = null;
  let confirmationSubmitter = null;
  document.querySelectorAll("form[data-delete-dialog]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      const selectable = form.querySelectorAll('input[name="product_ids"]');
      if (selectable.length && !form.querySelector('input[name="product_ids"]:checked')) {
        event.preventDefault();
        form.querySelector("[data-bulk-bar]")?.classList.add("needs-selection");
        window.setTimeout(() => form.querySelector("[data-bulk-bar]")?.classList.remove("needs-selection"), 800);
        return;
      }
      if (!confirmationDialog) return;
      event.preventDefault();
      formAwaitingConfirmation = form;
      confirmationSubmitter = event.submitter;
      const requestedOperation = confirmationSubmitter?.dataset.operation;
      const operationInput = form.querySelector("[data-bulk-operation]");
      if (requestedOperation && operationInput) operationInput.value = requestedOperation;
      const count = form.querySelectorAll('input[name="product_ids"]:checked').length;
      const requestedMessage = confirmationSubmitter?.dataset.confirmMessage || form.dataset.deleteMessage;
      const message = count
        ? `${requestedMessage || "确定继续吗？"}（${count} 件）`
        : (requestedMessage || "确定继续吗？");
      confirmationDialog.querySelector("[data-confirm-message]").textContent = message;
      openDialog(confirmationDialog);
    });
  });
  confirmationDialog?.querySelector("[data-confirm-action]")?.addEventListener("click", () => {
    const form = formAwaitingConfirmation;
    formAwaitingConfirmation = null;
    confirmationSubmitter = null;
    confirmationDialog.close();
    form?.submit();
  });
  confirmationDialog?.addEventListener("close", () => {
    formAwaitingConfirmation = null;
    confirmationSubmitter = null;
  });

  const productManagement = document.querySelector("[data-product-management]");
  const managementToggle = document.querySelector("[data-management-toggle]");
  if (productManagement && managementToggle) {
    const checkboxes = [...productManagement.querySelectorAll('input[name="product_ids"]')];
    const countLabel = productManagement.querySelector("[data-selection-count]");
    const selectAll = productManagement.querySelector("[data-select-all]");
    const updateSelection = () => {
      const selected = checkboxes.filter((item) => item.checked).length;
      if (countLabel) countLabel.textContent = selected;
      if (selectAll) selectAll.textContent = selected === checkboxes.length && selected ? "取消全选" : "全选本页";
    };
    managementToggle.addEventListener("click", () => {
      const managing = productManagement.classList.toggle("is-managing");
      managementToggle.classList.toggle("active", managing);
      managementToggle.setAttribute("aria-pressed", String(managing));
      managementToggle.querySelector("span").textContent = managing ? "完成" : "管理";
      if (!managing) checkboxes.forEach((item) => { item.checked = false; });
      updateSelection();
    });
    checkboxes.forEach((item) => item.addEventListener("change", updateSelection));
    selectAll?.addEventListener("click", () => {
      const shouldSelect = !checkboxes.every((item) => item.checked);
      checkboxes.forEach((item) => { item.checked = shouldSelect; });
      updateSelection();
    });
    productManagement.querySelectorAll(".product-main-link").forEach((link) => {
      link.addEventListener("click", (event) => {
        if (!productManagement.classList.contains("is-managing")) return;
        event.preventDefault();
        const checkbox = link.closest(".product-list-item")?.querySelector('input[name="product_ids"]');
        if (checkbox) {
          checkbox.checked = !checkbox.checked;
          updateSelection();
        }
      });
    });
  }

  const entryDialog = document.querySelector("#productEntryDialog");
  const barcodeDialog = document.querySelector("#barcodeDialog");
  document.querySelectorAll("[data-open-barcode]").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      entryDialog?.close();
      window.setTimeout(() => openDialog(barcodeDialog), 40);
    });
  });

  if (barcodeDialog) {
    const photoInput = barcodeDialog.querySelector("[data-barcode-photo]");
    const manualForm = barcodeDialog.querySelector("[data-barcode-manual]");
    const feedback = barcodeDialog.querySelector("[data-barcode-feedback]");
    const csrf = barcodeDialog.dataset.csrf;

    const setBarcodeStatus = (message, isError = false) => {
      feedback.replaceChildren();
      const status = document.createElement("p");
      status.className = `lookup-state${isError ? " error" : ""}`;
      status.textContent = message;
      feedback.appendChild(status);
    };

    const showBarcodeResult = (data) => {
      feedback.replaceChildren();
      const product = data.product || {};
      const result = document.createElement("section");
      result.className = "barcode-result";
      if (product.catalog_image_url) {
        const image = document.createElement("img");
        image.src = product.catalog_image_url;
        image.alt = "商品图片";
        result.appendChild(image);
      } else {
        const placeholder = document.createElement("span");
        placeholder.className = "barcode-result-placeholder";
        placeholder.textContent = "条码";
        result.appendChild(placeholder);
      }
      const copy = document.createElement("div");
      const name = document.createElement("b");
      name.textContent = data.exists
        ? product.name
        : (data.found ? (product.name || "已找到商品资料") : "未找到公开资料");
      const meta = document.createElement("small");
      meta.textContent = [product.brand, product.specification, data.barcode].filter(Boolean).join(" · ");
      copy.append(name, meta);
      result.appendChild(copy);
      const action = document.createElement("a");
      action.className = "button primary full";
      action.href = data.exists ? data.detail_url : data.new_url;
      action.textContent = data.exists ? "查看商品" : "继续建档";
      result.appendChild(action);
      feedback.appendChild(result);
    };

    const lookupBarcode = async (url, options) => {
      setBarcodeStatus("正在识别…");
      try {
        const response = await fetch(url, options);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "识别失败");
        showBarcodeResult(data);
      } catch (error) {
        setBarcodeStatus(error.message || "识别失败，请重试。", true);
      }
    };

    photoInput?.addEventListener("change", () => {
      const file = photoInput.files?.[0];
      if (!file) return;
      const body = new FormData();
      body.append("barcode_photo", file);
      lookupBarcode("/api/products/barcode/scan", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body,
      });
      photoInput.value = "";
    });

    manualForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const code = new FormData(manualForm).get("barcode")?.toString().trim();
      if (!code) {
        setBarcodeStatus("请输入条码。", true);
        return;
      }
      lookupBarcode(`/api/products/barcode/${encodeURIComponent(code)}`, {
        headers: { "Accept": "application/json" },
      });
    });
  }

  const preview = document.querySelector("#photoPreview");
  document.querySelectorAll("[data-photo-input]").forEach((input) => {
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file || !preview) return;
      document.querySelectorAll("[data-photo-input]").forEach((other) => {
        if (other !== input) other.value = "";
      });
      const image = document.createElement("img");
      image.alt = "待上传商品图片";
      image.src = URL.createObjectURL(file);
      image.onload = () => URL.revokeObjectURL(image.src);
      preview.replaceChildren(image);
    });
  });

  const productAI = document.querySelector("[data-product-ai]");
  if (productAI) {
    const description = productAI.querySelector("#productDescription");
    const voiceButton = productAI.querySelector("[data-voice-input]");
    const organizeButton = productAI.querySelector("[data-ai-organize]");
    const status = productAI.querySelector("[data-ai-status]");
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;
    let listening = false;

    const setListening = (active) => {
      listening = active;
      voiceButton.classList.toggle("is-listening", active);
      voiceButton.querySelector("span").textContent = active ? "正在听…" : "语音输入";
    };

    if (SpeechRecognition) {
      recognition = new SpeechRecognition();
      recognition.lang = "zh-CN";
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.onstart = () => {
        setListening(true);
        status.textContent = "请说出商品名称、价格、库存和供应商等信息。";
      };
      recognition.onresult = (event) => {
        const transcript = Array.from(event.results)
          .map((result) => result[0]?.transcript || "")
          .join("")
          .trim();
        if (transcript) {
          description.value = `${description.value.trim()} ${transcript}`.trim();
          status.textContent = "已转成文字，点击“AI 整理信息”。";
        }
      };
      recognition.onerror = () => {
        status.textContent = "没有听清，请再试一次或直接输入文字。";
      };
      recognition.onend = () => setListening(false);
      voiceButton.addEventListener("click", () => {
        if (listening) recognition.stop();
        else recognition.start();
      });
    } else {
      voiceButton.addEventListener("click", () => {
        status.textContent = "当前浏览器不支持语音转文字，请直接输入商品信息。";
        description.focus();
      });
    }

    organizeButton.addEventListener("click", async () => {
      const content = description.value.trim();
      if (!content) {
        status.textContent = "请先说出或输入商品信息。";
        description.focus();
        return;
      }
      organizeButton.disabled = true;
      organizeButton.textContent = "正在整理…";
      status.textContent = "AI 正在提取商品资料。";
      try {
        const response = await fetch("/api/products/ai-draft", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": productAI.dataset.csrf },
          body: JSON.stringify({ description: content }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "整理失败");
        let filled = 0;
        Object.entries(data.draft || {}).forEach(([field, value]) => {
          const input = document.querySelector(`[name="${field}"]`);
          if (!input || value === null || value === "") return;
          input.value = value;
          input.classList.add("ai-filled");
          window.setTimeout(() => input.classList.remove("ai-filled"), 2200);
          filled += 1;
        });
        status.textContent = `已整理并填写 ${filled} 项，请核对后保存商品。`;
        document.querySelector('[name="name"]')?.focus({ preventScroll: true });
      } catch (error) {
        status.textContent = error.message || "整理失败，请稍后重试。";
      } finally {
        organizeButton.disabled = false;
        organizeButton.textContent = "AI 整理信息";
      }
    });
  }

  const chat = document.querySelector("[data-chat]");
  if (!chat) return;
  const form = document.querySelector("#chatForm");
  const input = document.querySelector("#chatInput");
  const messages = document.querySelector("#chatMessages");
  const button = form.querySelector("button");
  let lastId = Number(messages.querySelector("[data-message-id]:last-of-type")?.dataset.messageId || 0);
  let sending = false;

  const scrollToBottom = () => { messages.scrollTop = messages.scrollHeight; };
  const appendInlineMarkdown = (container, line) => {
    const pieces = line.split(/(\*\*[^*]+\*\*)/g);
    pieces.forEach((piece) => {
      if (piece.startsWith("**") && piece.endsWith("**") && piece.length > 4) {
        const strong = document.createElement("strong");
        strong.textContent = piece.slice(2, -2);
        container.appendChild(strong);
      } else {
        container.appendChild(document.createTextNode(piece));
      }
    });
  };
  const renderMessageBody = (container, content) => {
    container.replaceChildren();
    let list = null;
    let listType = "";
    String(content).split("\n").forEach((rawLine) => {
      const line = rawLine.trimEnd();
      const unordered = line.match(/^\s*[-•]\s+(.+)/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)/);
      const nextType = unordered ? "ul" : (ordered ? "ol" : "");
      if (nextType) {
        if (!list || listType !== nextType) {
          list = document.createElement(nextType);
          listType = nextType;
          container.appendChild(list);
        }
        const item = document.createElement("li");
        appendInlineMarkdown(item, (unordered || ordered)[1]);
        list.appendChild(item);
        return;
      }
      list = null;
      listType = "";
      if (!line.trim()) return;
      const paragraph = document.createElement("p");
      appendInlineMarkdown(paragraph, line);
      container.appendChild(paragraph);
    });
  };
  messages.querySelectorAll(".message-body").forEach((body) => {
    renderMessageBody(body, body.textContent);
  });
  const addMessage = ({ id = "", role, content, sender_name, channel }, extraClass = "") => {
    document.querySelector("#chatEmpty")?.remove();
    const article = document.createElement("article");
    article.className = `message ${role} ${extraClass}`.trim();
    if (id) article.dataset.messageId = id;
    article.innerHTML = `<div class="message-meta"><span>${escapeHtml(sender_name || (role === "assistant" ? "BHS AI" : "成员"))}</span><span>${channel === "WECHAT" ? "微信" : "网页"}</span></div><div class="message-body"></div>`;
    renderMessageBody(article.querySelector(".message-body"), content);
    messages.appendChild(article);
    if (id) lastId = Math.max(lastId, Number(id));
    scrollToBottom();
    return article;
  };

  const addActionProposal = (article, proposal) => {
    if (!proposal?.id) return;
    const card = document.createElement("section");
    card.className = "ai-action-card";
    card.dataset.actionId = proposal.id;
    const label = document.createElement("span");
    label.className = "ai-action-label";
    label.textContent = "待确认操作";
    const summary = document.createElement("b");
    summary.textContent = proposal.summary;
    const actions = document.createElement("div");
    actions.className = "ai-action-buttons";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.dataset.aiAction = "cancel";
    cancel.textContent = "取消";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.dataset.aiAction = "confirm";
    confirm.textContent = "确认执行";
    actions.append(cancel, confirm);
    card.append(label, summary, actions);
    article.appendChild(card);
    scrollToBottom();
  };

  messages.addEventListener("click", async (event) => {
    const control = event.target.closest("[data-ai-action]");
    if (!control) return;
    const card = control.closest("[data-action-id]");
    if (!card || card.classList.contains("is-processing")) return;
    card.classList.add("is-processing");
    card.querySelectorAll("button").forEach((item) => { item.disabled = true; });
    const operation = control.dataset.aiAction;
    try {
      const response = await fetch(`/api/ai/actions/${card.dataset.actionId}/${operation}`, {
        method: "POST",
        headers: { "X-CSRF-Token": chat.dataset.csrf, "Accept": "application/json" },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "操作失败");
      card.classList.add(operation === "confirm" ? "is-confirmed" : "is-cancelled");
      card.querySelector(".ai-action-label").textContent = data.message;
      card.querySelector(".ai-action-buttons").remove();
      if (data.detail_url) {
        const link = document.createElement("a");
        link.href = data.detail_url;
        link.textContent = "查看商品 →";
        card.appendChild(link);
      }
    } catch (error) {
      card.classList.remove("is-processing");
      card.querySelectorAll("button").forEach((item) => { item.disabled = false; });
      card.querySelector(".ai-action-label").textContent = error.message || "操作失败";
    }
  });

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
  });
  input.addEventListener("focus", () => {
    window.setTimeout(() => {
      scrollToBottom();
      input.scrollIntoView({ block: "nearest" });
    }, 120);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  document.querySelectorAll("[data-prompt]").forEach((prompt) => {
    prompt.addEventListener("click", () => {
      input.value = prompt.dataset.prompt;
      input.dispatchEvent(new Event("input"));
      input.focus();
    });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const content = input.value.trim();
    if (!content || sending) return;
    sending = true;
    button.disabled = true;
    addMessage({ role: "user", content, sender_name: "我", channel: "WEB" });
    input.value = "";
    input.style.height = "auto";
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": chat.dataset.csrf },
        body: JSON.stringify({ message: content }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "发送失败");
      const article = addMessage({ id: data.id, role: "assistant", content: data.answer, sender_name: "BHS AI", channel: "WEB" });
      addActionProposal(article, data.proposal);
    } catch (error) {
      addMessage({ role: "assistant", content: error.message || "暂时无法连接 AI。", sender_name: "系统", channel: "WEB" }, "error");
    } finally {
      sending = false;
      button.disabled = false;
      input.focus();
    }
  });

  const poll = async () => {
    if (document.hidden || sending) return;
    try {
      const response = await fetch(`/api/messages?after=${lastId}`, { headers: { "Accept": "application/json" } });
      if (!response.ok) return;
      const incoming = await response.json();
      incoming.forEach((message) => {
        if (!messages.querySelector(`[data-message-id="${message.id}"]`)) addMessage(message);
      });
    } catch (_) { /* The next poll retries quietly. */ }
  };
  scrollToBottom();
  if (chat.dataset.autosend === "true" && input.value.trim()) {
    window.history.replaceState({}, "", "/assistant");
    window.setTimeout(() => form.requestSubmit(), 80);
  }
  window.setInterval(poll, 3000);
})();
