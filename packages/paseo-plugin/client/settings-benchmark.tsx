/**
 * The "Benchmark" settings card: renders `benchmarkCard()` for the job `useBenchmark` polls — a
 * models × processors table of decision times — and runs its actions through the benchmark,
 * select-engine and selection-mode RPCs.
 */
import { useRpc } from '@getpaseo/plugin/client';
import { SettingsCard, SettingsRow } from '@getpaseo/plugin/client/ui';
import { useRef, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import {
  benchmarkCard,
  type BenchAction,
  type BenchmarkCard as Card,
  type Cell,
  type Row,
} from '../shared/benchmark-card.ts';
import type { BenchmarkView } from '../shared/benchmark.ts';
import type { EngineCatalog } from '../shared/engines.ts';
import {
  benchmarkCancelRpc,
  benchmarkStartRpc,
  selectEngineRpc,
  selectionModeRpc,
} from '../shared/rpc.ts';
import { outcomeOf, useAction } from './hooks.ts';
import { Badge, Button, Progress, type Theme } from './ui.tsx';

/** Presses of Cancel closer together than this are one press. */
const CANCEL_GUARD_MS = 500;
const MODEL_WIDTH = 140;
const CELL_WIDTH = 104;

interface Props {
  readonly theme: Theme;
  readonly catalog: EngineCatalog;
  /** The job from `useBenchmark`: undefined while loading, null when the gateway has none. */
  readonly view: BenchmarkView | null | undefined;
}

type Runner = ReturnType<typeof useAction>;
type Press = (a: BenchAction) => void;

function startBody(a: BenchAction): Record<string, unknown> {
  if (a.targets.length > 0) {
    return {
      targets: a.targets.slice(0, 32).map((t) => ({
        engine: t.engine,
        model: t.model,
        ...(t.device === null ? {} : { device: t.device }),
      })),
    };
  }
  return { scope: 'installed', ...(a.only === null ? {} : { only: a.only }) };
}

function useBenchmarkActions(runner: Runner): Press {
  const start = useRpc(benchmarkStartRpc);
  const cancel = useRpc(benchmarkCancelRpc);
  const select = useRpc(selectEngineRpc);
  const setMode = useRpc(selectionModeRpc);
  const lastCancel = useRef(0);
  const cancelRun = (): void => {
    const now = Date.now();
    if (now - lastCancel.current < CANCEL_GUARD_MS) return;
    lastCancel.current = now;
    void runner.run('cancel', async () =>
      outcomeOf(await cancel({}), 'Cancelling. Finished results are kept.'),
    );
  };
  const automatic = (a: BenchAction): void => {
    void runner.run('auto', async () =>
      outcomeOf(
        await setMode({ mode: 'auto', ...(a.family === null ? {} : { family: a.family }) }),
        'Automatic selection is on.',
      ),
    );
  };
  const restore = (a: BenchAction): void => {
    const t = a.targets[0];
    if (t === undefined) return;
    void runner.run('restore', async () =>
      outcomeOf(
        await select({ engine: t.engine, model: t.model, device: t.device ?? 'auto' }),
        'Switching back. Decisions are passed to you until it is ready.',
      ),
    );
  };
  const startRun = (a: BenchAction): void => {
    void runner.run('start', async () =>
      outcomeOf(await start(startBody(a)), 'Benchmark started.'),
    );
  };
  return (a) => {
    if (a.kind === 'cancel') cancelRun();
    else if (a.kind === 'auto') automatic(a);
    else if (a.kind === 'restore') restore(a);
    else startRun(a);
  };
}

function ActionButton({
  theme,
  action,
  busy,
  primary = false,
  onPress,
}: {
  theme: Theme;
  action: BenchAction;
  busy: boolean;
  primary?: boolean;
  onPress: Press;
}): ReactNode {
  return (
    <Button
      theme={theme}
      label={action.label}
      hint={action.hint}
      variant={primary ? 'primary' : 'secondary'}
      disabled={action.disabled || (busy && action.kind !== 'cancel')}
      onPress={() => onPress(action)}
    />
  );
}

function Muted({ theme, children }: { theme: Theme; children: string }): ReactNode {
  return (
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
      {children}
    </Text>
  );
}

function Plain({ theme, children }: { theme: Theme; children: string }): ReactNode {
  return (
    <Text style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 18 }}>{children}</Text>
  );
}

function Live({ theme, card }: { theme: Theme; card: Card }): ReactNode {
  const p = card.progress;
  return (
    <>
      {card.activity === null ? null : <Plain theme={theme}>{card.activity}</Plain>}
      {p === null ? null : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Progress theme={theme} value={p.fraction} />
          <Muted theme={theme}>{p.text}</Muted>
        </View>
      )}
      {card.note === null ? null : <Muted theme={theme}>{card.note}</Muted>}
    </>
  );
}

function Controls({
  theme,
  card,
  busy,
  onPress,
}: {
  theme: Theme;
  card: Card;
  busy: boolean;
  onPress: Press;
}): ReactNode {
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <ActionButton theme={theme} action={card.primary} busy={busy} primary onPress={onPress} />
        {card.secondary.map((a) => (
          <ActionButton key={a.label} theme={theme} action={a} busy={busy} onPress={onPress} />
        ))}
      </View>
      {card.summary === null ? null : <Muted theme={theme}>{card.summary}</Muted>}
    </View>
  );
}

// ── the table ────────────────────────────────────────────────────────────────────────────────

function cellColor(theme: Theme, cell: Cell): string {
  if (cell.kind === 'failed') return theme.colors.statusDanger;
  if (cell.fastest) return theme.colors.statusSuccess;
  return cell.kind === 'time' ? theme.colors.foreground : theme.colors.foregroundMuted;
}

/** The small line under a cell's value: fastest, in use, out of date, the format. */
function cellTags(cell: Cell): string | null {
  const tags = [
    cell.fastest ? 'fastest' : null,
    cell.inUse ? 'in use' : null,
    cell.stale ? 'out of date' : null,
    cell.background ? 'background only' : null,
    cell.format,
  ].filter((t): t is string => t !== null);
  return tags.length === 0 ? null : tags.join(' · ');
}

function TableCell({ theme, cell }: { theme: Theme; cell: Cell }): ReactNode {
  const tags = cellTags(cell);
  return (
    <View accessible accessibilityLabel={cell.accessibleName} style={{ width: CELL_WIDTH, gap: 2 }}>
      <Text
        style={{
          color: cellColor(theme, cell),
          fontSize: 14,
          fontWeight: cell.fastest ? '600' : '400',
          fontVariant: ['tabular-nums'],
        }}
      >
        {cell.text}
      </Text>
      {tags === null ? null : (
        <Text
          style={{
            color: cell.stale ? theme.colors.statusWarning : theme.colors.foregroundMuted,
            fontSize: 11,
            lineHeight: 14,
          }}
        >
          {tags}
        </Text>
      )}
    </View>
  );
}

function TableRow({ theme, row, last }: { theme: Theme; row: Row; last: boolean }): ReactNode {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        paddingVertical: 8,
        borderBottomWidth: last ? 0 : 1,
        borderColor: theme.colors.border,
      }}
    >
      <View style={{ width: MODEL_WIDTH, gap: 4 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{row.label}</Text>
        {row.inUse ? <Badge theme={theme} text="In use" /> : null}
      </View>
      {row.cells.map((cell) => (
        <TableCell key={cell.column} theme={theme} cell={cell} />
      ))}
    </View>
  );
}

function Table({ theme, card }: { theme: Theme; card: Card }): ReactNode {
  if (card.rows.length === 0) {
    return null;
  }
  const head = { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: '600' as const };
  return (
    <View style={{ gap: 6 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View
            accessibilityRole="header"
            style={{
              flexDirection: 'row',
              gap: 8,
              paddingBottom: 6,
              borderBottomWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            <Text style={[head, { width: MODEL_WIDTH }]}>Model</Text>
            {card.columns.map((col) => (
              <Text key={col.key} style={[head, { width: CELL_WIDTH }]}>
                {col.label}
              </Text>
            ))}
          </View>
          {card.rows.map((row, i) => (
            <TableRow key={row.family} theme={theme} row={row} last={i === card.rows.length - 1} />
          ))}
        </View>
      </ScrollView>
      {card.legend === null ? null : <Muted theme={theme}>{card.legend}</Muted>}
    </View>
  );
}

function Problems({
  theme,
  card,
  busy,
  onPress,
}: {
  theme: Theme;
  card: Card;
  busy: boolean;
  onPress: Press;
}): ReactNode {
  if (card.problems.length === 0) {
    return null;
  }
  return (
    <View style={{ gap: 8 }}>
      <Text
        accessibilityRole="header"
        style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: '600' }}
      >
        Failed
      </Text>
      {card.problems.map((p) => (
        <View key={p.key} style={{ gap: 6 }}>
          <Text
            selectable
            style={{ color: theme.colors.statusDanger, fontSize: 13, lineHeight: 18 }}
          >
            {p.text}
          </Text>
          <ActionButton theme={theme} action={p.retry} busy={busy} onPress={onPress} />
        </View>
      ))}
    </View>
  );
}

function RestoreFailure({
  theme,
  failure,
  busy,
  onPress,
}: {
  theme: Theme;
  failure: NonNullable<Card['restoreFailure']>;
  busy: boolean;
  onPress: Press;
}): ReactNode {
  return (
    <View
      accessibilityRole="alert"
      style={{
        gap: 8,
        padding: 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
      }}
    >
      <Text style={{ color: theme.colors.statusDanger, fontSize: 13, lineHeight: 18 }}>
        {failure.text}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <ActionButton theme={theme} action={failure.retry} busy={busy} primary onPress={onPress} />
        <ActionButton theme={theme} action={failure.auto} busy={busy} onPress={onPress} />
      </View>
    </View>
  );
}

function Outcome({ theme, runner }: { theme: Theme; runner: Runner }): ReactNode {
  const o = runner.outcome;
  if (o === null) {
    return null;
  }
  return (
    <Text
      accessibilityRole={o.tone === 'error' ? 'alert' : 'text'}
      style={{
        color: o.tone === 'error' ? theme.colors.statusDanger : theme.colors.foregroundMuted,
        fontSize: 13,
      }}
    >
      {o.text}
    </Text>
  );
}

export function BenchmarkCard({ theme, catalog, view }: Props): ReactNode {
  const runner = useAction();
  const perform = useBenchmarkActions(runner);
  if (view == null) {
    // No benchmark endpoint (older gateway), or not read yet.
    return null;
  }
  const card = benchmarkCard(view, catalog);
  const busy = runner.busy !== null;
  return (
    <SettingsCard>
      <SettingsRow label="Benchmark">
        {card.stateLabel === null ? null : <Badge theme={theme} text={card.stateLabel} />}
      </SettingsRow>
      <View style={{ gap: 12, paddingHorizontal: 16, paddingVertical: 8 }}>
        <Muted theme={theme}>{card.description}</Muted>
        <Live theme={theme} card={card} />
        {card.status === null ? null : <Plain theme={theme}>{card.status}</Plain>}
        <Controls theme={theme} card={card} busy={busy} onPress={perform} />
        {card.restoreFailure === null ? null : (
          <RestoreFailure
            theme={theme}
            failure={card.restoreFailure}
            busy={busy}
            onPress={perform}
          />
        )}
        <Outcome theme={theme} runner={runner} />
        <Table theme={theme} card={card} />
        <Problems theme={theme} card={card} busy={busy} onPress={perform} />
        {card.footer.map((line) => (
          <Muted key={line} theme={theme}>
            {line}
          </Muted>
        ))}
        <Text accessibilityLiveRegion="polite" style={{ height: 0, opacity: 0 }}>
          {card.announcement ?? ''}
        </Text>
      </View>
    </SettingsCard>
  );
}
