export async function firefliesQuery<T>(key: string, query: string, variables: Record<string, unknown> = {}, transport = fetch): Promise<T> {
  let response: Response;
  try {
    response = await transport('https://api.fireflies.ai/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000), cache: 'no-store',
    });
  } catch { throw new Error('Fireflies did not confirm the request. Check Fireflies before trying again.'); }
  if (!response.ok) throw new Error(response.status === 429 ? 'Fireflies rate limit reached. Try again later.' : 'Fireflies request failed. Check the connection and plan.');
  const result = await response.json();
  if (result.errors?.length || !result.data) throw new Error('Fireflies rejected the request. Check the API key and plan.');
  return result.data as T;
}
export async function sendFireflies(key: string, meeting: string, title: string, duration: number) {
  const result = await firefliesQuery<{addToLiveMeeting:{success:boolean}}>(key,
    `mutation Join($link:String!,$title:String!,$duration:Int!){addToLiveMeeting(meeting_link:$link,title:$title,duration:$duration){success}}`,
    { link: meeting, title, duration });
  if (!result.addToLiveMeeting?.success) throw new Error('Fireflies could not join this meeting.');
}
