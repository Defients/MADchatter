/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_KICK_CLIENT_ID?: string;
  readonly VITE_KICK_PUSHER_KEY?: string;
  readonly VITE_JOYSTICK_CLIENT_ID?: string;
  readonly VITE_JOYSTICK_CLIENT_SECRET?: string;
  readonly VITE_JOYSTICK_TOKEN_PROXY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
