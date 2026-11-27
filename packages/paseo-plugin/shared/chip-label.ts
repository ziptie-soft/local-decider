/** What a screen reader says for a chip option: its label, then what it does when there is a detail. */
export function optionAccessibilityLabel(option: {
  readonly label: string;
  readonly detail?: string | undefined;
}): string {
  return option.detail === undefined ? option.label : `${option.label}. ${option.detail}`;
}
