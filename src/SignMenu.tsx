import { translateUi } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

/** The toolbar's Sign button in the desktop app: a handwritten signature, or a digital one with a certificate. */
export function SignMenu({ onHandwritten, onDigital }: { onHandwritten: () => void; onDigital: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key, true);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);

  const pick = (action: () => void) => { setOpen(false); action(); };
  return <div className="more sign-menu" ref={ref}>
    <button className={open ? "on" : ""} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={translateUi("Sign")} title={translateUi("Add a signature")}>
      <Icon name="signature" size={16} /><span>{translateUi("Sign")}</span><Icon name="chevronDown" size={13} />
    </button>
    {open && <div className="menu dropdown" role="menu" aria-label={translateUi("Sign")} onKeyDown={event => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      const index = items.indexOf(document.activeElement as HTMLElement);
      items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }}>
      <button role="menuitem" onClick={() => pick(onHandwritten)}><Icon name="signature" size={15} /><span className="menu-label">{translateUi("Handwritten signature")}</span></button>
      <button role="menuitem" onClick={() => pick(onDigital)}><Icon name="lock" size={15} /><span className="menu-label">{translateUi("Digital signature (certificate)")}</span></button>
    </div>}
  </div>;
}
