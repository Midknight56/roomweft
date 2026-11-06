export function measureControls(): { control: string; problem: string }[];
export function takeShots(baseUrl: string, outDir: string): Promise<{ screen: string; control: string; problem: string }[]>;
