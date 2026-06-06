/**
 * expo-conductor — define tasks with rich execution policies and many triggers.
 *
 * The default export `Conductor` is a ready-to-use singleton bound to the platform
 * backend (native module on iOS/Android, Web engine on web). Advanced consumers can
 * construct their own {@link ConductorClient} with a custom backend.
 */
import { ConductorClient } from './Conductor';
import type { ConductorBackend } from './ConductorBackend';
import NativeBackend from './ExpoConductorModule';

export * from './ExpoConductor.types';
export { ConductorClient } from './Conductor';
export type { ConductorBackend, ConductorSubscription } from './ConductorBackend';

/** The platform backend (native module or web engine). */
export const backend: ConductorBackend = NativeBackend;

/** Ready-to-use Conductor bound to the platform backend. */
export const Conductor = new ConductorClient(backend);

export default Conductor;
