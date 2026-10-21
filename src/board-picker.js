import { boardLogoUrl } from "./messages-api.js";

const resultLimit = 20;

function boardAvatar(board) {
  const avatar = document.createElement("span");
  avatar.className = "create-board-avatar";
  avatar.setAttribute("aria-hidden", "true");
  const initial = board.slug.charAt(0).toUpperCase();
  avatar.textContent = initial;
  const logoUrl = boardLogoUrl(board.logo_url);
  if (logoUrl) {
    const logo = document.createElement("img");
    logo.alt = "";
    logo.width = 28;
    logo.height = 28;
    logo.loading = "lazy";
    logo.onerror = () => { avatar.textContent = initial; };
    logo.src = logoUrl;
    avatar.replaceChildren(logo);
  }
  return avatar;
}

export function mountBoardPicker(onChange) {
  const root = document.querySelector("#create-board-picker");
  const input = document.querySelector("#create-board");
  const selectedIcon = document.querySelector("#create-board-selected-icon");
  const panel = document.querySelector("#create-board-results");
  const list = document.querySelector("#create-board-options");
  const status = document.querySelector("#create-board-results-status");
  let boards = [];
  let selected = null;
  let visible = [];
  let activeIndex = -1;

  function selectedBoard() {
    return selected && input.value === `y/${selected.slug}` ? selected : null;
  }

  function syncSelection() {
    const board = selectedBoard();
    input.setCustomValidity(board ? "" : "Choose a sub-yap from the list.");
    selectedIcon.hidden = !board;
    selectedIcon.replaceChildren(...(board ? [boardAvatar(board)] : []));
    input.classList.toggle("has-board-icon", Boolean(board));
  }

  function close() {
    panel.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function setActive(index, scroll = false) {
    activeIndex = index;
    [...list.children].forEach((option, candidate) => {
      option.setAttribute("aria-selected", String(candidate === index));
    });
    const option = list.children[index];
    if (option) {
      input.setAttribute("aria-activedescendant", option.id);
      if (scroll) option.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  function render() {
    const query = selectedBoard() ? "" : input.value.trim().toLowerCase().replace(/^y\//, "");
    const words = query.split(/\s+/).filter(Boolean);
    const matches = boards.filter(({ search }) => words.every(word => search.includes(word)));
    if (!query && selectedBoard()) {
      const index = matches.findIndex(({ board }) => board.id === selected.id);
      if (index > 0) matches.unshift(...matches.splice(index, 1));
    }
    visible = matches.slice(0, resultLimit).map(({ board }) => board);
    list.replaceChildren(...visible.map((board, index) => {
      const option = document.createElement("li");
      option.id = `create-board-option-${index}`;
      option.className = "create-board-option";
      option.setAttribute("role", "option");
      option.tabIndex = -1;
      option.title = `${board.name} (y/${board.slug})`;
      const labels = document.createElement("span");
      labels.className = "create-board-option-labels";
      const slug = document.createElement("span");
      slug.textContent = `y/${board.slug}`;
      const name = document.createElement("span");
      name.className = "create-board-option-name";
      name.textContent = board.name;
      labels.append(slug, name);
      option.append(boardAvatar(board), labels);
      option.addEventListener("click", () => choose(board));
      option.addEventListener("pointermove", () => { if (activeIndex !== index) setActive(index); });
      return option;
    }));
    status.textContent = !matches.length ? "No sub-yaps found."
      : matches.length > resultLimit ? `Showing ${resultLimit} of ${matches.length.toLocaleString()} sub-yaps. Keep typing to narrow your search.`
        : `${matches.length} sub-yap${matches.length === 1 ? "" : "s"} found.`;
    list.scrollTop = 0;
    setActive(visible.length ? 0 : -1);
  }

  function open() {
    if (input.disabled) return;
    render();
    panel.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function choose(board) {
    if (input.disabled) return;
    selected = board;
    input.value = `y/${board.slug}`;
    syncSelection();
    input.focus();
    close();
    onChange();
  }

  input.addEventListener("focus", () => {
    if (selectedBoard()) input.select();
    open();
  });
  input.addEventListener("click", () => {
    if (selectedBoard()) input.select();
    open();
  });
  input.addEventListener("input", () => {
    syncSelection();
    open();
    onChange();
  });
  input.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const wasClosed = panel.hidden;
      if (wasClosed) open();
      if (visible.length) {
        const next = wasClosed ? (event.key === "ArrowUp" ? visible.length - 1 : 0)
          : (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length;
        setActive(next, true);
      }
    } else if (event.key === "Enter" && !panel.hidden) {
      event.preventDefault();
      if (visible[activeIndex]) choose(visible[activeIndex]);
    } else if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      event.stopPropagation();
      if (selected) {
        input.value = `y/${selected.slug}`;
        syncSelection();
        onChange();
      }
      close();
    } else if (event.key === "Tab") close();
  });
  list.addEventListener("mousedown", event => event.preventDefault());
  root.addEventListener("focusout", event => {
    if (!root.contains(event.relatedTarget)) close();
  });
  document.addEventListener("pointerdown", event => {
    if (!root.contains(event.target)) close();
  });
  syncSelection();

  return {
    get value() { return selectedBoard()?.id ?? ""; },
    setBoards(nextBoards, selectedId = selected?.id) {
      boards = nextBoards.map(board => ({ board, search: `${board.slug} ${board.name}`.toLowerCase() }));
      selected = nextBoards.find(board => board.id === selectedId) ?? null;
      input.value = selected ? `y/${selected.slug}` : "";
      syncSelection();
      if (!panel.hidden) render();
    },
    setDisabled(disabled) {
      input.disabled = disabled;
      if (disabled) close();
    },
    reset() {
      selected = null;
      input.value = "";
      syncSelection();
      close();
    },
    close,
  };
}
