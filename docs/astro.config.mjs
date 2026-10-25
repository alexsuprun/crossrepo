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
						{ label: 'xr codebase clone', slug: 'commands/codebase-clone' },
						{ label: 'xr codebase pull', slug: 'commands/codebase-pull' },
						{ label: 'xr codebase repo add', slug: 'commands/codebase-repo-add' },
						{ label: 'xr codebase repo list', slug: 'commands/codebase-repo-list' },
						{ label: 'xr codebase repo remove', slug: 'commands/codebase-repo-remove' },
						{ label: 'xr config show', slug: 'commands/config-show' },
						{ label: 'xr project create', slug: 'commands/project-create' },
					],
				},
			],
			plugins: [starlightLlmsTxt()],
		}),
	],
});
