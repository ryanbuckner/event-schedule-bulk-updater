/**
 * Inline cell editors for the bulk grid.
 *
 * A note on dates: the time-of-day picker and `DatePicker` below still never
 * let the browser's own time zone leak into a stored value. Every wall-clock
 * value this file works with is a plain `YYYY-MM-DD` / `HH:MM` string in the
 * schedule item's own `timeZoneId` — an organizer in Denver editing a London
 * event means London wall-clock time. `DatePicker` exchanges `Date` objects,
 * so `ymdToLocalDate`/`localDateToYmd` below round-trip through *local*
 * getters/constructor only (never `toISOString`, which is UTC-based and can
 * shift the calendar day near midnight) — the Date instant it produces is
 * never read as anything but a same-day stand-in for the picker widget.
 *
 * A separate note on language: date and time *display* here follows the Wix
 * dashboard user's own Language & Region preference — `i18n.getLocale()`
 * from `@wix/essentials`, the SDK's documented way for a dashboard extension
 * to read it (confirmed against its own example: formatting a date via
 * `Intl.DateTimeFormat(i18n.getLocale())`). Nothing here hardcodes "en".
 */

import {
  AutoComplete,
  Box,
  DatePicker,
  IconButton,
  Input,
  MultiSelect,
  StatusIndicator,
  Text,
  Tooltip,
  type MultiSelectTag,
} from '@wix/design-system';
import { SupportedWixLocales } from '@wix/design-systems-locale-utils';
import { i18n } from '@wix/essentials';
import { Hidden, Publish, Unsaved, Visible } from '@wix/wix-ui-icons-common';
import React, { useMemo, useRef, useState } from 'react';
import { fromInputStrings, toInputStrings } from '../../../lib/datetime';
import { LIMITS, type RowError, type ScheduleRowFields } from '../../../lib/types';

/** Shared with the legend in `ScheduleEditor.tsx`, so the icons mean the same thing everywhere. */
export const UNSAVED_ICON_COLOR = '#B54900';
export const UNPUBLISHED_ICON_COLOR = '#3899EC';

/** `YYYY-MM-DD` -> a Date at local midnight, for `DatePicker`'s `value`. */
function ymdToLocalDate(ymd: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Inverse of `ymdToLocalDate`. Reads local getters only — never UTC. */
function localDateToYmd(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Every 10-minute time of day, as 24-hour `HH:MM`. */
const TIME_VALUES: string[] = Array.from({ length: 144 }, (_, i) => {
  const minutes = i * 10;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
});

/**
 * 24-hour `HH:MM` -> locale-formatted display text: "9:30 AM" for a
 * 12-hour locale, "14:30" for a 24-hour one — whichever the given locale
 * uses by default. The date is an arbitrary fixed placeholder; only the
 * hour/minute portion is ever read from the formatted output.
 */
function formatTimeOfDay(hhmm24: string, locale: string): string {
  const [h, m] = hhmm24.split(':').map(Number);
  const reference = new Date(2000, 0, 1, h, m);
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(reference);
}

/**
 * Inverse of `formatTimeOfDay`, loosely. Accepts plain 24-hour "HH:MM" (or
 * "H:MM") first — locale-independent, and what most non-US locales display
 * by default — then falls back to English 12-hour AM/PM ("9a", "11:5pm"), so
 * typing still works regardless of the active locale. Returns null if
 * neither form matches.
 */
function parseTimeOfDay(input: string): string | null {
  const trimmed = input.trim();

  const h24 = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (h24) {
    const hour = Number(h24[1]);
    const minute = Number(h24[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }

  const h12 = /^(\d{1,2})(?::(\d{1,2}))?\s*([AaPp])[Mm]?$/.exec(trimmed);
  if (h12) {
    const hour = Number(h12[1]);
    const minute = h12[2] ? Number(h12[2]) : 0;
    if (hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59) {
      const period = h12[3].toLowerCase();
      const hour24 = period === 'a' ? hour % 12 : (hour % 12) + 12;
      return `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }

  return null;
}

/** A `DatePicker`-supported locale nearest to the Wix dashboard user's actual locale. */
function toDatePickerLocale(locale: string): SupportedWixLocales {
  const supported = SupportedWixLocales as readonly string[];
  if (supported.includes(locale)) return locale as SupportedWixLocales;
  const language = locale.split('-')[0];
  if (supported.includes(language)) return language as SupportedWixLocales;
  return 'en';
}

/** Nearest 10-minute option's id for a given 24-hour `HH:MM`; exact ties (:x5) round down. */
function nearestTimeOptionId(hhmm24: string): string | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm24);
  if (!match) return undefined;
  const totalMinutes = Number(match[1]) * 60 + Number(match[2]);
  const remainder = totalMinutes % 10;
  const rounded =
    remainder <= 5 ? totalMinutes - remainder : totalMinutes + (10 - remainder);
  const clamped = Math.min(Math.max(rounded, 0), 24 * 60 - 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

/** Widest option ("12:50 PM") plus breathing room. */
const TIME_SELECT_WIDTH = '92px';

/**
 * Time-of-day picker: a 10-minute-increment dropdown that also accepts typed
 * input, validated as you type. `value`/`onChange` are 24-hour `HH:MM`; the
 * displayed and typed text follows the dashboard user's own locale (12-hour
 * "9:30 AM" or 24-hour "14:30", whichever that locale defaults to).
 */
function TimeOfDaySelect({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const locale = i18n.getLocale();
  const timeOptions = useMemo(
    () => TIME_VALUES.map((v) => ({ id: v, value: formatTimeOfDay(v, locale) })),
    [locale],
  );
  const [text, setText] = useState(() => (value ? formatTimeOfDay(value, locale) : ''));

  // Resets the local typing buffer when the committed value changes from
  // outside (e.g. a bulk time shift, or a reload) — a deliberate state
  // adjustment during render, not an effect, so it never lags a frame behind.
  const lastValue = useRef(value);
  if (lastValue.current !== value) {
    lastValue.current = value;
    setText(value ? formatTimeOfDay(value, locale) : '');
  }

  const invalid = text.trim() !== '' && parseTimeOfDay(text) === null;

  return (
    <Box width={TIME_SELECT_WIDTH}>
      <AutoComplete
        size="small"
        value={text}
        disabled={disabled}
        options={timeOptions}
        menuArrow={false}
        dropdownWidth="160px"
        minWidthPixels="160"
        focusOnOption={nearestTimeOptionId(value)}
        popoverProps={{ appendTo: 'window' }}
        status={invalid ? 'error' : undefined}
        statusMessage={invalid ? 'Enter a time like 9:30 AM or 14:30.' : undefined}
        onChange={(event) => {
          const typed = event.target.value;
          setText(typed);
          const parsed = parseTimeOfDay(typed);
          if (parsed) onChange(parsed);
        }}
        onSelect={(option) => {
          setText(String(option.value));
          onChange(String(option.id));
        }}
      />
    </Box>
  );
}

/** Field-level error message for a cell, if any. */
function errorFor(errors: RowError[] | undefined, field: string): string | undefined {
  return errors?.find((error) => error.field === field)?.message;
}

interface CellProps {
  values: ScheduleRowFields;
  errors: RowError[] | undefined;
  disabled: boolean;
}

export function NameCell({
  values,
  errors,
  disabled,
  onChange,
}: CellProps & { onChange: (value: string) => void }) {
  const message = errorFor(errors, 'name');

  // Buffered locally, same reasoning as `TimeSlotCell` below: the grid's
  // underlying table keys rows by their array index, not item id, and
  // re-renders on every edit (each row's dirty/status state changes as you
  // type). Binding `value` straight to `values.name` meant every keystroke
  // re-drove the input from that external value — content ended up correct,
  // but the browser resets the caret to the end whenever an input's value is
  // reassigned externally, even to text that already matches what's there.
  // Buffering avoids re-deriving the DOM value from outside on every render;
  // it only re-syncs when the committed value actually changes underneath
  // this cell (e.g. a CSV import, or a reload).
  const [text, setText] = useState(values.name);
  const lastCommitted = useRef(values.name);
  if (lastCommitted.current !== values.name && values.name !== text) {
    lastCommitted.current = values.name;
    setText(values.name);
  }

  return (
    <Input
      size="small"
      value={text}
      maxLength={LIMITS.NAME_MAX}
      placeholder="Session name"
      status={message ? 'error' : undefined}
      statusMessage={message}
      disabled={disabled}
      // WDS `Input` also defaults to selecting all text on focus, which
      // would make the first keystroke after clicking into an existing name
      // replace the whole thing instead of inserting at the click position.
      autoSelect={false}
      onChange={(event) => {
        setText(event.target.value);
        lastCommitted.current = event.target.value;
        onChange(event.target.value);
      }}
    />
  );
}

/**
 * Place, suggested from the other places already used in this schedule.
 *
 * Free text, not a locked selection: the Schedule Items API has no place
 * taxonomy of its own (confirmed against its schema — `stageName` is a plain
 * string, same as tags), so `options` here is just this schedule's own
 * existing values, offered as a shortcut to avoid re-typing "Main Stage" on
 * every row. Typing something new is still just as valid.
 */
export function PlaceCell({
  value,
  options,
  message,
  disabled,
  onChange,
}: {
  value: string;
  options: string[];
  message?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const placeOptions = useMemo(() => options.map((place) => ({ id: place, value: place })), [options]);
  return (
    <AutoComplete
      size="small"
      value={value}
      options={placeOptions}
      maxLength={LIMITS.STAGE_NAME_MAX}
      placeholder="Room or stage"
      menuArrow={placeOptions.length > 0}
      status={message ? 'error' : undefined}
      statusMessage={message}
      disabled={disabled}
      popoverProps={{ appendTo: 'window' }}
      onChange={(event) => onChange(event.target.value)}
      onSelect={(option) => onChange(String(option.value))}
    />
  );
}

/**
 * Date + time pair for one end of the time slot.
 *
 * Both halves are edited as wall-clock strings in the item's own zone; the
 * instant is only recomputed when a valid pair exists. Deriving that pair
 * straight from `iso` on every render would drop a date pick made while the
 * time side is still blank (or vice versa) — `fromInputStrings` can't form
 * an instant from half a pair, so `onChange` never fires, `iso` never
 * changes, and the picker appears to silently revert. Local state buffers
 * each half so picking date and time in two steps — the normal flow for a
 * brand-new row — actually accumulates instead of losing the first pick.
 */
export function TimeSlotCell({
  iso,
  timeZoneId,
  message,
  disabled,
  onChange,
}: {
  iso: string;
  timeZoneId: string;
  message?: string;
  disabled: boolean;
  onChange: (iso: string) => void;
}) {
  const committed = toInputStrings(iso, timeZoneId) ?? { date: '', time: '' };
  const [date, setDate] = useState(committed.date);
  const [time, setTime] = useState(committed.time);

  // Re-buffer from outside only when the committed instant actually changes
  // (e.g. a bulk time shift, or a reload) — not on every render, which would
  // overwrite an in-progress half-entered pick with the last committed value.
  const lastIso = useRef(iso);
  if (lastIso.current !== iso) {
    lastIso.current = iso;
    const resynced = toInputStrings(iso, timeZoneId) ?? { date: '', time: '' };
    setDate(resynced.date);
    setTime(resynced.time);
  }

  const update = (nextDate: string, nextTime: string) => {
    setDate(nextDate);
    setTime(nextTime);
    const next = fromInputStrings(nextDate, nextTime, timeZoneId);
    // An incomplete pair is buffered locally above but not yet a valid
    // instant, so it's not sent up until the other half is also set.
    if (next) onChange(next);
  };

  return (
    <Box direction="vertical" gap="SP1">
      <Box gap="SP1" verticalAlign="middle">
        <DatePicker
          size="small"
          locale={toDatePickerLocale(i18n.getLocale())}
          dateStyle="medium"
          width="140px"
          value={ymdToLocalDate(date)}
          disabled={disabled}
          popoverProps={{ appendTo: 'window' }}
          status={message ? 'error' : undefined}
          onChange={(picked) => update(localDateToYmd(picked), time)}
        />
        <TimeOfDaySelect
          value={time}
          disabled={disabled}
          onChange={(nextTime) => update(date, nextTime)}
        />
      </Box>
      {message ? (
        <Text size="tiny" skin="error">
          {message}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * Tags as pills, matching the native Wix schedule editor: type a tag, press
 * Tab (or Enter, or a comma) to turn it into a pill. `MultiSelect` supports
 * this directly via `onManuallyInput` — no predefined tag list to select
 * from, since the Schedule Items API has no tag taxonomy of its own; every
 * tag is freeform, scoped to that one item. Drag a pill to reorder it within
 * the item's own tag list.
 */
export function TagsCell({
  values,
  errors,
  disabled,
  onChange,
}: CellProps & { onChange: (tags: string[]) => void }) {
  const message = errorFor(errors, 'tags');
  const tags: MultiSelectTag[] = values.tags.map((tag) => ({ id: tag, label: tag }));

  return (
    <MultiSelect
      size="small"
      tags={tags}
      placeholder="Type a tag, press Tab"
      status={message ? 'error' : undefined}
      statusMessage={message}
      disabled={disabled}
      popoverProps={{ appendTo: 'window' }}
      onManuallyInput={(entered) => {
        const next = [...values.tags];
        for (const raw of entered) {
          const trimmed = raw.trim();
          if (trimmed && !next.includes(trimmed)) next.push(trimmed);
        }
        onChange(next);
      }}
      onRemoveTag={(tagId) => onChange(values.tags.filter((tag) => tag !== tagId))}
      onReorder={({ addedIndex, removedIndex }) => {
        const next = values.tags.slice();
        next.splice(addedIndex, 0, ...next.splice(removedIndex, 1));
        onChange(next);
      }}
    />
  );
}

/** Eye-icon visibility toggle, matching the show/hide pattern used elsewhere in Wix. */
export function HiddenCell({
  values,
  disabled,
  onChange,
}: Omit<CellProps, 'errors'> & { onChange: (hidden: boolean) => void }) {
  return (
    <Tooltip
      content={
        values.hidden
          ? "Hidden from guests. Click to show in the schedule."
          : 'Visible to guests. Click to hide from the schedule.'
      }
    >
      <IconButton
        size="small"
        priority="tertiary"
        skin="standard"
        disabled={disabled}
        ariaLabel={values.hidden ? 'Show to guests' : 'Hide from guests'}
        onClick={() => onChange(!values.hidden)}
      >
        {values.hidden ? <Hidden /> : <Visible />}
      </IconButton>
    </Tooltip>
  );
}

/**
 * Read-only per-row markers: an unsaved local edit and a schedule-wide
 * unpublished draft are independent conditions, so both icons can show on
 * the same row at once — a validation error takes over the whole slot
 * instead, since a row that can't be saved shouldn't also claim to be merely
 * "unpublished."
 */
export function RowStatusIcons({
  dirty,
  unpublished,
  errors,
}: {
  dirty: boolean;
  unpublished: boolean;
  errors: RowError[] | undefined;
}) {
  if (errors && errors.length > 0) {
    return (
      <StatusIndicator
        status="error"
        message={errors.map((error) => error.message).join(' ')}
      />
    );
  }
  // Always the same shape — both icon slots stay mounted, toggled by
  // `visibility` rather than by conditionally rendering them. The status
  // column sits right next to Item Name in the grid, and this cell used to
  // return `null` outright until a row went dirty; the first keystroke that
  // makes a row dirty landed on the exact same render as the edited cell's
  // own value update, and that sibling cell going from nothing to a mounted
  // Tooltip+icon on that render was enough to reset focus/selection in the
  // cell being typed into. Keeping the DOM shape constant avoids that.
  return (
    <Box gap="SP1" verticalAlign="middle">
      <span style={{ visibility: dirty ? 'visible' : 'hidden' }}>
        <Tooltip content="Unsaved changes: edited, not yet saved to the draft schedule.">
          <Unsaved size="18px" color={UNSAVED_ICON_COLOR} />
        </Tooltip>
      </span>
      <span style={{ visibility: unpublished ? 'visible' : 'hidden' }}>
        <Tooltip content="Unpublished changes: saved to the draft, but guests still see the last published schedule.">
          <Publish size="18px" color={UNPUBLISHED_ICON_COLOR} />
        </Tooltip>
      </span>
    </Box>
  );
}
