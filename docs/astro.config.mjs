// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLlmsTxt from 'starlight-llms-txt';

// https://astro.build/config
export default defineConfig({
	site: 'https://alexsuprun.github.io',
	base: '/crossrepo',
	integrations: [
		starlight({
			title: 'crossrepo',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/alexsuprun/crossrepo' }],
			sidebar: [
				{ label: 'Install', slug: 'install' },
				{ label: 'Output and errors', slug: 'output' },
				{
					label: 'Commands',
					items: [
						{ label: 'xr codebase init', slug: 'commands/codebase-init' },
						{ label: 'xr config show', slug: 'commands/config-show' },
					],
				},
			],
			plugins: [starlightLlmsTxt()],
		}),
	],
});
