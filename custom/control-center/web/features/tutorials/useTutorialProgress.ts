import { useCallback, useState } from 'react';
import { readProgress, type PartProgress } from '../../lib/tutorial-progress';

/** The progress of every part of one tutorial, read when the tutorial changes and kept up to date as the player saves. */
export function useTutorialProgress(tutorialId: string | undefined) {
  const [state, setState] = useState(() => ({ id: tutorialId, progress: tutorialId ? readProgress(tutorialId) : {} }));
  let progress = state.progress;
  if (state.id !== tutorialId) {
    progress = tutorialId ? readProgress(tutorialId) : {};
    setState({ id: tutorialId, progress });
  }
  // A player saves once more as it unmounts, which can be after the page moved to another tutorial: that save is for its own
  // tutorial (already in storage) and must not land in the progress of the one on screen.
  const record = useCallback(
    (forTutorial: string, partId: string, p: PartProgress) => setState((prev) => (prev.id === forTutorial ? { ...prev, progress: { ...prev.progress, [partId]: p } } : prev)),
    [],
  );
  return { progress, record };
}
