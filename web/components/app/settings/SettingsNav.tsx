"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { Select } from "@/components/ui";
import { cn } from "@/lib/cn";

const ITEMS = [
  { key: "", label: "General" },
  { key: "/members", label: "Members" },
  { key: "/api-keys", label: "API keys" },
  { key: "/mcp", label: "Connect an agent" },
  { key: "/ai", label: "AI research" },
  { key: "/company", label: "Company profile" },
  { key: "/data", label: "Data" },
];

/** Settings sub-nav (SYSTEM §4.9): a 180px left column, a select on phones. */
export function SettingsNav({ base }: { base: string }) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  const active = ITEMS.find((i) => i.key && rest.startsWith(i.key))?.key ?? "";
  return (
    <>
      <div className="sm:hidden">
        <label className="sr-only" htmlFor="settings-section">
          Settings section
        </label>
        <Select id="settings-section" tone="toolbar" value={active} onChange={(e) => router.push(`${base}${e.target.value}`)}>
          {ITEMS.map((i) => (
            <option key={i.key} value={i.key}>
              {i.label}
            </option>
          ))}
        </Select>
      </div>
      <nav aria-label="Settings" className="hidden sm:block">
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {ITEMS.map((i) => {
            const on = i.key === active;
            return (
              <li key={i.key}>
                <Link
                  href={`${base}${i.key}`}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "flex h-32 items-center rounded-sm px-10 font-medium transition-colors duration-[120ms]",
                    on ? "bg-sunk text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  {i.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
