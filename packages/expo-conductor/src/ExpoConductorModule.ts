import { requireNativeModule } from 'expo';

import type { ConductorBackend } from './ConductorBackend';

/**
 * The native module instance (Kotlin on Android, Swift on iOS). It implements
 * {@link ConductorBackend} via Expo Module `AsyncFunction`s and emits the task
 * lifecycle events. On web this file is replaced by `ExpoConductorModule.web.ts`.
 */
export default requireNativeModule<ConductorBackend>('ExpoConductorModule');
