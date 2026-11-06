export function visitorCookies(origin: string | undefined, visitor?: string): {
  name: string; value: string; url: string; httpOnly: boolean; secure: boolean; sameSite: 'Lax';
}[];

export function dragRoomObject(page: import('playwright').Page, id: string, x: number, z: number): Promise<void>;
