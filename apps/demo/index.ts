// Custom entry: register task handlers at MODULE scope BEFORE expo-router mounts the app.
//
// `./src/tasks` calls Conductor.defineTask(...) on import. The OS can relaunch the app
// headlessly (background / alarm / push) with no React tree mounting, so handlers must be
// registered here — at entry eval, before `expo-router/entry` boots the navigator.
import './src/tasks';
import 'expo-router/entry';
