"use client";

import { useMemo, useState } from "react";

import {
  Button,
  Combobox,
  CurrencyPicker,
  DateField,
  Field,
  StageDot,
  TimezonePicker,
  type ComboboxOption,
} from "@/components/ui";

import { NewWorkspaceDialog } from "@/components/app/settings/NewWorkspaceDialog";

import { STAGES, TZ } from "./sample";

const FIRST = ["Dana", "Marcus", "Priya", "Tomás", "Ines", "Hugo", "Amara", "Lena", "Owen", "Sofía", "Kenji", "Zoë", "Ravi", "Noor", "Elif", "Mateo", "Hana", "Felix", "Iris", "Jonah"];
const LAST = ["Whitfield", "Odell", "Varga", "Lindqvist", "Okafor", "Brandt", "Castellano", "Moreau", "Nakamura", "Pereira", "Haddad", "Kowalski", "Ferreira", "Aalto", "Quinn"];
const FIRMS = ["Harbor Light Ventures", "Juniper Angels", "Marrowstone Capital", "Fieldnote Partners", "Copperline", "Northgate Seed", "Tidewater Fund", "Larkspur Ventures"];

/** 600 fictional investors (example data only). */
const PEOPLE: ComboboxOption<string>[] = Array.from({ length: 600 }, (_, i) => {
  const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
  const firm = FIRMS[(i * 3) % FIRMS.length]!;
  return { value: `inv_${i}`, label: name, description: firm, keywords: [firm, `${name.split(" ")[0]!.toLowerCase()}@example.com`] };
});

/** Fake API search with 300ms latency, to show debounce, abort and "never stale". */
function slowSearch(query: string, signal: AbortSignal): Promise<ComboboxOption<string>[]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const q = query.trim().toLowerCase();
      if (q === "error") return reject(new Error("demo error"));
      resolve((q ? PEOPLE.filter((p) => `${p.label} ${p.description}`.toLowerCase().includes(q)) : PEOPLE).slice(0, 50));
    }, 300);
    signal.addEventListener("abort", () => clearTimeout(t));
  });
}

const FIELD_GROUPS: ComboboxOption<string>[] = [
  { value: "name", label: "Name", group: "Contact" },
  { value: "firm", label: "Firm", group: "Contact" },
  { value: "email", label: "Email", group: "Contact" },
  { value: "linkedin", label: "LinkedIn", group: "Contact" },
  { value: "type", label: "Investor type", group: "Contact", keywords: ["vc", "angel"] },
  { value: "stage", label: "Pipeline stage", group: "In Seed" },
  { value: "fit", label: "Fit", group: "In Seed" },
  { value: "follow_up_on", label: "Follow up on", group: "In Seed", keywords: ["next", "date"] },
  { value: "amount_soft", label: "Soft amount", group: "In Seed", disabled: true, description: "Map a stage first" },
];

/** Picker specimens for /design: sync, async, grouped, empty and disabled, plus the domain pickers. */
export function PickersDemo() {
  const [stage, setStage] = useState<string | null>("meeting");
  const [person, setPerson] = useState<string | null>(null);
  const [field, setField] = useState<string | null>("email");
  const [tz, setTz] = useState("Asia/Yerevan");
  const [cur, setCur] = useState("AMD");
  const [follow, setFollow] = useState<string | null>("2026-10-16");
  const [close, setClose] = useState<string | null>(null);
  const [newWs, setNewWs] = useState(false);
  const stageOptions = useMemo<ComboboxOption<string>[]>(
    () => STAGES.map((s) => ({ value: s.key, label: s.label, hint: <span className="tnum">{s.count}</span> })),
    [],
  );
  const stageColor = Object.fromEntries(STAGES.map((s) => [s.key, s.color])) as Record<string, (typeof STAGES)[number]["color"]>;

  return (
    <div className="grid grid-cols-1 gap-12 sm:grid-cols-2">
      <Field label="Timezone" hint="Try sf, ist, +4, kiev or sao paulo.">
        <TimezonePicker value={tz} onChange={setTz} suggest={TZ} />
      </Field>
      <Field label="Currency" hint="Try €, dram, rupee or armenia.">
        <CurrencyPicker value={cur} onChange={setCur} suggestFrom={{ timeZone: tz }} />
      </Field>
      <Field label="Follow up on" hint="Keys 0 1 3 m 7 2, ⌫ clears; or type fri, +7, oct 20.">
        <DateField value={follow} onChange={setFollow} timeZone={TZ} placeholder="Set follow-up" />
      </Field>
      <Field label="Target close date" optional>
        <DateField value={close} onChange={setClose} timeZone={TZ} quickPicks="deadline" placeholder="Set a close date" />
      </Field>
      <Field label="Stage (sync)">
        <Combobox
          value={stage}
          onChange={setStage}
          options={stageOptions}
          searchPlaceholder="Search stages"
          renderValue={(o) =>
            o ? (
              <span className="flex items-center gap-8">
                <StageDot color={stageColor[o.value] ?? "slate"} />
                {o.label}
              </span>
            ) : null
          }
        />
      </Field>
      <Field label="Investor (async, 300ms)" hint={`600 fictional investors. Type "error" to see Retry.`}>
        <Combobox
          value={person}
          onChange={setPerson}
          loadOptions={slowSearch}
          placeholder="Find an investor"
          searchPlaceholder="Name or firm"
          clearable
        />
      </Field>
      <Field label="Import field (grouped)">
        <Combobox value={field} onChange={setField} options={FIELD_GROUPS} clearable placeholder="Ignore this column" />
      </Field>
      <Field label="Owner (500+ rows, windowed)">
        <Combobox value={null} onChange={() => undefined} options={PEOPLE} placeholder="Anyone" searchPlaceholder="Search people" />
      </Field>
      <Field label="Tag (empty)">
        <Combobox
          value={null}
          onChange={() => undefined}
          options={[]}
          placeholder="No tags yet"
          emptyText={() => "No tags in this workspace yet. Add one on an investor."}
        />
      </Field>
      <Field label="Disabled">
        <TimezonePicker value="Europe/Berlin" onChange={() => undefined} disabled size="sm" />
      </Field>
      <div className="flex items-end sm:col-span-2">
        <Button onClick={() => setNewWs(true)}>New workspace dialog</Button>
      </div>
      <NewWorkspaceDialog open={newWs} onClose={() => setNewWs(false)} />
    </div>
  );
}
