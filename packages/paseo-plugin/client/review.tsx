/** The daily review on the status popover and the Details page; both render nothing while off. */
import { SettingsCard, SettingsRow, SettingsSection } from '@getpaseo/plugin/client/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';

import { reviewChecked, reviewHeadline, type ReviewSummary } from '../shared/review.ts';
import { useDailyReview, useDeciderValues } from './hooks.ts';
import type { Theme } from './ui.tsx';
import { Value } from './ui.tsx';

interface ReviewText {
  readonly review: ReviewSummary | null;
  readonly headline: string;
  readonly checked: string;
}

/** The review as text for a screen, or null while the setting is off. Re-renders each minute. */
function useReviewText(): ReviewText | null {
  const values = useDeciderValues();
  const enabled = values?.dailyReview === true;
  const { data } = useDailyReview(enabled);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [enabled]);
  if (!enabled) {
    return null;
  }
  const review = data?.review ?? null;
  return {
    review,
    headline: review === null ? 'Daily review' : reviewHeadline(review),
    checked: reviewChecked(data?.checkedAt ?? null, now),
  };
}

/** One line under the popover's modes: the headline, and when it was checked. */
export function ReviewPopoverSection({ theme }: { theme: Theme }): ReactNode {
  const text = useReviewText();
  if (text === null) {
    return null;
  }
  return (
    <>
      <View style={{ height: 1, backgroundColor: theme.colors.border }} />
      <View style={{ paddingHorizontal: 16, gap: 2 }}>
        <Text
          style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 18 }}
          numberOfLines={3}
        >
          {text.headline}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>
          {text.checked}
        </Text>
      </View>
    </>
  );
}

/** The Details page's list of the newest disagreements, with the command that explains one. */
export function ReviewSection({ theme }: { theme: Theme }): ReactNode {
  const text = useReviewText();
  if (text === null) {
    return null;
  }
  const { review } = text;
  return (
    <SettingsSection title="Daily review">
      <SettingsCard>
        <SettingsRow label={text.headline} hint={text.checked}>
          <Value theme={theme} muted>
            {review === null ? '—' : String(review.total)}
          </Value>
        </SettingsRow>
        {(review?.rows ?? []).map((row) => (
          <SettingsRow
            key={row.decisionId}
            label={`${row.class} · ${row.policy}${row.tool === null ? '' : ` · ${row.tool}`}`}
            hint={`local-decider explain ${row.decisionId}`}
          >
            <Value theme={theme} muted>
              {row.ts.slice(11, 16)}
            </Value>
          </SettingsRow>
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}
