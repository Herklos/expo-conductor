import { registerRootComponent } from 'expo';

// Register task handlers at module scope (before the app mounts) so they survive a
// headless background/alarm/push relaunch. See src/tasks.ts.
import './src/tasks';
import App from './src/App';

registerRootComponent(App);
