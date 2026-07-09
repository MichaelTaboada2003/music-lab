// ============================================================
// dropdown.js — mejora visual para <select> nativos.
//
// Los <option> de un <select> nativo son un widget del sistema
// operativo: la mayoría de navegadores ignoran background/color
// aplicados a <option>. Este módulo esconde el <select> real
// (que sigue siendo la fuente de verdad para su .value y para
// eventos 'change') y superpone un dropdown propio construido
// con divs que sí acepta el sistema de diseño.
//
// Uso:
//   import { enhanceSelect } from "./dropdown.js";
//   enhanceSelect(document.getElementById("miSelect"));
//
// El resto del código sigue accediendo al <select> normalmente
// (.value, addEventListener("change", ...), innerHTML = ...); el
// dropdown custom se sincroniza automáticamente.
// ============================================================

export function enhanceSelect(sel) {
  if (!sel || sel.dataset.enhanced === "1") return;
  sel.dataset.enhanced = "1";

  // Wrapper que ocupa el espacio original del select para no romper el layout.
  const wrapper = document.createElement("div");
  wrapper.className = "select-custom";
  sel.parentNode.insertBefore(wrapper, sel);
  wrapper.appendChild(sel);
  sel.classList.add("select-hidden");

  // Botón que muestra la opción actual.
  const button = document.createElement("button");
  button.type = "button";
  button.className = "select-button";
  wrapper.appendChild(button);

  // Panel de opciones (oculto por defecto).
  const panel = document.createElement("div");
  panel.className = "select-panel";
  panel.hidden = true;
  wrapper.appendChild(panel);

  let hoveredIndex = -1;

  function render() {
    const current = sel.options[sel.selectedIndex];
    button.textContent = current ? current.textContent : "—";

    panel.innerHTML = "";
    Array.from(sel.options).forEach((opt, i) => {
      const item = document.createElement("div");
      item.className =
        "select-item" + (i === sel.selectedIndex ? " selected" : "");
      item.textContent = opt.textContent;
      item.addEventListener("click", () => selectIndex(i));
      item.addEventListener("mouseenter", () => setHovered(i));
      panel.appendChild(item);
    });
    hoveredIndex = sel.selectedIndex;
  }

  function selectIndex(i) {
    if (i < 0 || i >= sel.options.length) return;
    sel.selectedIndex = i;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    render();
    close();
  }

  function setHovered(i) {
    hoveredIndex = i;
    panel.querySelectorAll(".select-item").forEach((el, idx) => {
      el.classList.toggle("hover", idx === i);
    });
  }

  function open() {
    if (!panel.hidden) return;
    // Cerrar cualquier otro dropdown abierto para evitar solapes.
    document
      .querySelectorAll(".select-custom.open")
      .forEach((w) => w !== wrapper && w.dispatchEvent(new Event("close-me")));

    panel.hidden = false;
    wrapper.classList.add("open");
    setHovered(sel.selectedIndex);
    setTimeout(() => {
      document.addEventListener("click", handleOutside);
      document.addEventListener("keydown", handleKeys);
    }, 0);
  }

  function close() {
    panel.hidden = true;
    wrapper.classList.remove("open");
    document.removeEventListener("click", handleOutside);
    document.removeEventListener("keydown", handleKeys);
  }

  function handleOutside(e) {
    if (!wrapper.contains(e.target)) close();
  }

  function handleKeys(e) {
    if (e.key === "Escape") { close(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHovered(Math.min(hoveredIndex + 1, sel.options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHovered(Math.max(hoveredIndex - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectIndex(hoveredIndex);
    }
  }

  wrapper.addEventListener("close-me", close);
  button.addEventListener("click", () => (panel.hidden ? open() : close()));

  // Cuando el <select> es repoblado programáticamente (refreshSongSelect
  // hace innerHTML="" y appends), el observer re-renderiza el custom.
  sel.addEventListener("change", render);
  new MutationObserver(render).observe(sel, {
    childList: true,
    subtree: false,
  });

  render();
}
