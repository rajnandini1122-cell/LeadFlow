import { useId } from 'react';
import {
  PRESET_LABELS,
  RANGE_PRESETS,
  type RangePreset,
  type RangeSelection,
  type ReportRange,
  type ReportScope,
} from './use-reports';

/**
 * Range selector shared by every reporting screen.
 *
 * Rendered as a radio group rather than a row of buttons so a screen reader
 * announces it as one control with a current selection, and arrow keys move
 * between the options the way they do in any other set of choices.
 */
export function DateRangePicker({
  value,
  onChange,
}: {
  value: RangeSelection;
  onChange: (next: RangeSelection) => void;
}): React.JSX.Element {
  const groupId = useId();

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="sr-only">Date range</legend>
        <div className="flex flex-wrap gap-1.5">
          {RANGE_PRESETS.map((preset) => (
            <PresetChip
              key={preset}
              name={groupId}
              preset={preset}
              active={value.preset === preset}
              onSelect={() =>
                onChange(
                  preset === 'custom'
                    ? { preset, from: value.from ?? today(), to: value.to ?? today() }
                    : { preset },
                )
              }
            />
          ))}
        </div>
      </fieldset>

      {value.preset === 'custom' && (
        <div className="flex flex-wrap items-end gap-3">
          <DateField
            label="From"
            value={value.from ?? ''}
            max={value.to}
            onChange={(from) => onChange({ ...value, preset: 'custom', from })}
          />
          <DateField
            label="To"
            value={value.to ?? ''}
            min={value.from}
            onChange={(to) => onChange({ ...value, preset: 'custom', to })}
          />
        </div>
      )}
    </div>
  );
}

function PresetChip({
  name,
  preset,
  active,
  onSelect,
}: {
  name: string;
  preset: RangePreset;
  active: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <label
      className={`cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium transition ${
        active
          ? 'bg-slate-900 text-white'
          : 'bg-white text-slate-600 ring-1 ring-slate-200 ring-inset hover:bg-slate-50'
      }`}
    >
      <input
        type="radio"
        name={name}
        className="sr-only"
        checked={active}
        onChange={onSelect}
      />
      {PRESET_LABELS[preset]}
    </label>
  );
}

function DateField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min?: string | undefined;
  max?: string | undefined;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const id = useId();

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-600">
        {label}
      </label>
      <input
        id={id}
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none transition focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
      />
    </div>
  );
}

/**
 * States exactly which days were counted, and in whose timezone.
 *
 * Without this the reader cannot tell whether "this week" started on Sunday or
 * Monday, or whose midnight ended it — and two people comparing the same screen
 * from different countries would reasonably reach different conclusions.
 */
export function RangeSummary({
  range,
  scope,
}: {
  range: ReportRange;
  scope: ReportScope;
}): React.JSX.Element {
  return (
    <p className="text-xs text-slate-500">
      {range.fromDate === range.toDate
        ? range.fromDate
        : `${range.fromDate} to ${range.toDate}`}
      <span className="mx-1.5 text-slate-300">·</span>
      <span title="Day boundaries use the organization's timezone">{range.timezone}</span>
      {scope === 'OWN' && (
        <>
          <span className="mx-1.5 text-slate-300">·</span>
          <span className="font-medium text-amber-700">Your leads only</span>
        </>
      )}
    </p>
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
