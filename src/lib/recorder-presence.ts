export type MeetParticipant = {
  name: string; earliestStartTime?: string;
  signedinUser?: { displayName?: string };
  anonymousUser?: { displayName?: string };
  phoneUser?: { displayName?: string };
};
export function recorderPresence(participants: MeetParticipant[]) {
  const isRecorder = (p: MeetParticipant) => /fireflies|notetaker/i.test(
    p.signedinUser?.displayName || p.anonymousUser?.displayName || p.phoneUser?.displayName || '');
  return {
    recorder: participants.some(isRecorder),
    humans: participants.filter(p => !isRecorder(p)),
  };
}
// Recover only a late arrival, never a bot removed during an attended interview.
export function lateArrival(joinAt: string, firstHumanAt: string | null, now = Date.now()) {
  const requested = Date.parse(joinAt);
  return !!firstHumanAt && Date.parse(firstHumanAt) - requested >= 10 * 60000 && now - requested >= 13 * 60000;
}
