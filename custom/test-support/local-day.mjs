// For specs that prove a script dates things by the local day: a time zone on another calendar day than UTC right now.
// UTC+14 is a day ahead from 10:00 UTC and UTC-11 a day behind before 11:00 UTC, so one of them always differs.
export const dayIn = (timeZone, at) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

export function zoneOffUtcDay(now = new Date()) {
  const utc = now.toISOString().slice(0, 10);
  const zone = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].find((z) => dayIn(z, now) !== utc);
  return { zone, localToday: dayIn(zone, now), utcToday: utc };
}
