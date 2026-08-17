export type SwingState = {
  previousRsi: number | null;
  armedShortEntry: boolean;
  armedShortExit: boolean;
  armedLongEntry: boolean;
  armedLongExit: boolean;
};

export function initialSwingState(): SwingState {
  return {
    previousRsi: null,
    armedShortEntry: false,
    armedShortExit: false,
    armedLongEntry: false,
    armedLongExit: false,
  };
}
