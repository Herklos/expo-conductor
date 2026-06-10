import { Redirect } from 'expo-router';

/** Entry route → the Lab tab. */
export default function Index() {
  return <Redirect href="/lab" />;
}
