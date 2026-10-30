/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import { IColorTheme, IThemeService, IFileIconTheme, IProductIconTheme } from '../../../../platform/theme/common/themeService.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { isBoolean, isString } from '../../../../base/common/types.js';
import { IconContribution, IconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';

export const IWorkbenchThemeService = refineServiceDecorator<IThemeService, IWorkbenchThemeService>(IThemeService);

export const THEME_SCOPE_OPEN_PAREN = '[';
export const THEME_SCOPE_CLOSE_PAREN = ']';
export const THEME_SCOPE_WILDCARD = '*';

export const themeScopeRegex = /\[(.+?)\]/g;

export enum ThemeSettings {
	COLOR_THEME = 'workbench.colorTheme',
	FILE_ICON_THEME = 'workbench.iconTheme',
	PRODUCT_ICON_THEME = 'workbench.productIconTheme',
	COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations',
	TOKEN_COLOR_CUSTOMIZATIONS = 'editor.tokenColorCustomizations',
	SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS = 'editor.semanticTokenColorCustomizations',

	PREFERRED_DARK_THEME = 'workbench.preferredDarkColorTheme',
	PREFERRED_LIGHT_THEME = 'workbench.preferredLightColorTheme',
	PREFERRED_HC_DARK_THEME = 'workbench.preferredHighContrastColorTheme', /* id kept for compatibility reasons */
	PREFERRED_HC_LIGHT_THEME = 'workbench.preferredHighContrastLightColorTheme',
	DETECT_COLOR_SCHEME = 'window.autoDetectColorScheme',
	DETECT_HC = 'window.autoDetectHighContrast',

	SYSTEM_COLOR_THEME = 'window.systemColorTheme'
}

export namespace ThemeSettingDefaults {
	export const COLOR_THEME_DARK = 'Omen Dark';
	export const COLOR_THEME_LIGHT = 'Light 2026';
	export const COLOR_THEME_HC_DARK = 'Default High Contrast';
	export const COLOR_THEME_HC_LIGHT = 'Default High Contrast Light';

	export const FILE_ICON_THEME = 'vs-seti';
	export const PRODUCT_ICON_THEME = 'Default';
}

/**
 * Migrates legacy and removed built-in theme settings IDs to Omen's single dark neutral theme.
 */
export function migrateThemeSettingsId(settingsId: string): string {
	switch (settingsId) {
		case 'Omen Warm Charcoal':
		case 'Dark 2026':
		case 'Light 2026':
		case 'Dark Modern':
		case 'Light Modern':
		case 'Dark+':
		case 'Light+':
		case 'Default Dark Modern':
		case 'Default Light Modern':
		case 'Default Dark+':
		case 'Default Light+':
		case 'Visual Studio Dark':
		case 'Visual Studio Light':
		case 'Default High Contrast':
		case 'Default High Contrast Light':
		case 'Solarized Dark':
		case 'Solarized Light':
		case 'Abyss':
		case 'Monokai':
		case 'Monokai Dimmed':
		case 'Kimbie Dark':
		case 'Quiet Light':
		case 'Red':
		case 'Tomorrow Night Blue':
		case 'Experimental Dark':
		case 'VS Code Dark':
		case 'Experimental Light':
		case 'VS Code Light':
			return ThemeSettingDefaults.COLOR_THEME_DARK;
	}
	return settingsId;
}

export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#272727',
	'activityBar.activeBorder': '#EDEDED',
	'activityBar.background': '#161616',
	'activityBar.border': '#222222',
	'activityBar.foreground': '#E6E6E6',
	'activityBar.inactiveForeground': '#858585',
	'activityBarBadge.background': '#2A2A2A',
	'activityBarBadge.foreground': '#EDEDED',
	'badge.background': '#2A2A2A',
	'badge.foreground': '#E6E6E6',
	'button.background': '#262626',
	'button.border': '#333333',
	'button.foreground': '#EDEDED',
	'button.hoverBackground': '#303030',
	'button.secondaryBackground': '#1F1F1F',
	'button.secondaryForeground': '#D4D4D4',
	'button.secondaryHoverBackground': '#292929',
	'chat.slashCommandBackground': '#2A2A2A',
	'chat.slashCommandForeground': '#EDEDED',
	'chat.editedFileForeground': '#DFB565',
	'checkbox.background': '#212121',
	'checkbox.border': '#363636',
	'debugToolBar.background': '#161616',
	'descriptionForeground': '#8A8A8A',
	'dropdown.background': '#212121',
	'dropdown.border': '#2E2E2E',
	'dropdown.foreground': '#E6E6E6',
	'dropdown.listBackground': '#1C1C1C',
	'editor.background': '#141414',
	'editor.findMatchBackground': '#FFBD2E38',
	'editor.foreground': '#E4E4E4',
	'editor.inactiveSelectionBackground': '#FFFFFF0F',
	'editor.selectionHighlightBackground': '#FFFFFF10',
	'editorGroup.border': '#222222',
	'editorGroupHeader.tabsBackground': '#161616',
	'editorGroupHeader.tabsBorder': '#222222',
	'editorGutter.addedBackground': '#27C93F',
	'editorGutter.deletedBackground': '#FF5F56',
	'editorGutter.modifiedBackground': '#E5B95C',
	'editorIndentGuide.activeBackground1': '#3A3A3A',
	'editorIndentGuide.background1': '#242424',
	'editorLineNumber.activeForeground': '#CFCFCF',
	'editorLineNumber.foreground': '#595959',
	'editorOverviewRuler.border': '#00000000',
	'editorWidget.background': '#1C1C1C',
	'errorForeground': '#F07167',
	'focusBorder': '#3A3A3A',
	'foreground': '#E6E6E6',
	'icon.foreground': '#8F8F8F',
	'input.background': '#212121',
	'input.border': '#2E2E2E',
	'input.foreground': '#E6E6E6',
	'input.placeholderForeground': '#858585',
	'inputOption.activeBackground': '#2C2C2C',
	'inputOption.activeBorder': '#3D3D3D',
	'keybindingLabel.foreground': '#E6E6E6',
	'list.activeSelectionIconForeground': '#EDEDED',
	'list.dropBackground': '#27272780',
	'menu.background': '#1C1C1C',
	'menu.border': '#2E2E2E',
	'menu.foreground': '#E6E6E6',
	'menu.selectionBackground': '#272727',
	'menu.separatorBackground': '#282828',
	'notificationCenterHeader.background': '#212121',
	'notificationCenterHeader.foreground': '#E6E6E6',
	'notifications.background': '#1C1C1C',
	'notifications.border': '#2E2E2E',
	'notifications.foreground': '#E6E6E6',
	'panel.background': '#161616',
	'panel.border': '#222222',
	'panelInput.border': '#2E2E2E',
	'panelTitle.activeBorder': '#EDEDED',
	'panelTitle.activeForeground': '#EDEDED',
	'panelTitle.inactiveForeground': '#858585',
	'peekViewEditor.background': '#181818',
	'peekViewEditor.matchHighlightBackground': '#FFBD2E29',
	'peekViewResult.background': '#161616',
	'peekViewResult.matchHighlightBackground': '#FFBD2E29',
	'pickerGroup.border': '#262626',
	'ports.iconRunningProcessForeground': '#27C93F',
	'progressBar.background': '#27C93F',
	'quickInput.background': '#1C1C1C',
	'quickInput.foreground': '#E6E6E6',
	'settings.dropdownBackground': '#212121',
	'settings.dropdownBorder': '#2E2E2E',
	'settings.headerForeground': '#EDEDED',
	'settings.modifiedItemIndicator': '#EDEDED',
	'sideBar.background': '#161616',
	'sideBar.border': '#222222',
	'sideBar.foreground': '#CFCFCF',
	'sideBarSectionHeader.background': '#161616',
	'sideBarSectionHeader.border': '#222222',
	'sideBarSectionHeader.foreground': '#858585',
	'sideBarTitle.foreground': '#E6E6E6',
	'statusBar.background': '#141414',
	'statusBar.border': '#222222',
	'statusBar.debuggingBackground': '#272727',
	'statusBar.debuggingForeground': '#EDEDED',
	'statusBar.focusBorder': '#3A3A3A',
	'statusBar.foreground': '#8A8A8A',
	'statusBar.noFolderBackground': '#141414',
	'statusBarItem.focusBorder': '#3A3A3A',
	'statusBarItem.prominentBackground': '#262626',
	'statusBarItem.remoteBackground': '#262626',
	'statusBarItem.remoteForeground': '#EDEDED',
	'tab.activeBackground': '#141414',
	'tab.activeBorder': '#141414',
	'tab.activeBorderTop': '#00000000',
	'tab.activeForeground': '#EDEDED',
	'tab.border': '#222222',
	'tab.hoverBackground': '#1F1F1F',
	'tab.inactiveBackground': '#161616',
	'tab.inactiveForeground': '#858585',
	'tab.lastPinnedBorder': '#2E2E2E',
	'tab.selectedBackground': '#272727',
	'tab.selectedBorderTop': '#00000000',
	'tab.selectedForeground': '#EDEDED',
	'tab.unfocusedActiveBorder': '#141414',
	'tab.unfocusedActiveBorderTop': '#00000000',
	'tab.unfocusedHoverBackground': '#1B1B1B',
	'terminal.foreground': '#E4E4E4',
	'terminal.inactiveSelectionBackground': '#FFFFFF0F',
	'terminal.tab.activeBorder': '#EDEDED',
	'textBlockQuote.background': '#1C1C1C',
	'textBlockQuote.border': '#2E2E2E',
	'textCodeBlock.background': '#1C1C1C',
	'textLink.activeForeground': '#EDEDED',
	'textLink.foreground': '#D4D4D4',
	'textPreformat.background': '#212121',
	'textPreformat.foreground': '#CFCFCF',
	'textSeparator.foreground': '#242424',
	'titleBar.activeBackground': '#141414',
	'titleBar.activeForeground': '#BDBDBD',
	'titleBar.border': '#222222',
	'titleBar.inactiveBackground': '#141414',
	'titleBar.inactiveForeground': '#7A7A7A',
	'welcomePage.progress.foreground': '#27C93F',
	'welcomePage.tileBackground': '#1C1C1C',
	'widget.border': '#2A2A2A'
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#dddddd',
	'activityBar.activeBorder': '#005FB8',
	'activityBar.background': '#F8F8F8',
	'activityBar.border': '#E5E5E5',
	'activityBar.foreground': '#1F1F1F',
	'activityBar.inactiveForeground': '#616161',
	'activityBarBadge.background': '#005FB8',
	'activityBarBadge.foreground': '#FFFFFF',
	'badge.background': '#CCCCCC',
	'badge.foreground': '#3B3B3B',
	'button.background': '#005FB8',
	'button.border': '#0000001a',
	'button.foreground': '#FFFFFF',
	'button.hoverBackground': '#0258A8',
	'button.secondaryBackground': '#E5E5E5',
	'button.secondaryForeground': '#3B3B3B',
	'button.secondaryHoverBackground': '#CCCCCC',
	'chat.slashCommandBackground': '#ADCEFF7A',
	'chat.slashCommandForeground': '#26569E',
	'chat.editedFileForeground': '#895503',
	'checkbox.background': '#F8F8F8',
	'checkbox.border': '#CECECE',
	'descriptionForeground': '#3B3B3B',
	'diffEditor.unchangedRegionBackground': '#f8f8f8',
	'dropdown.background': '#FFFFFF',
	'dropdown.border': '#CECECE',
	'dropdown.foreground': '#3B3B3B',
	'dropdown.listBackground': '#FFFFFF',
	'editor.background': '#FFFFFF',
	'editor.foreground': '#3B3B3B',
	'editor.inactiveSelectionBackground': '#E5EBF1',
	'editor.selectionHighlightBackground': '#ADD6FF80',
	'editorGroup.border': '#E5E5E5',
	'editorGroupHeader.tabsBackground': '#F8F8F8',
	'editorGroupHeader.tabsBorder': '#E5E5E5',
	'editorGutter.addedBackground': '#2EA043',
	'editorGutter.deletedBackground': '#F85149',
	'editorGutter.modifiedBackground': '#005FB8',
	'editorIndentGuide.activeBackground1': '#939393',
	'editorIndentGuide.background1': '#D3D3D3',
	'editorLineNumber.activeForeground': '#171184',
	'editorLineNumber.foreground': '#6E7681',
	'editorOverviewRuler.border': '#E5E5E5',
	'editorSuggestWidget.background': '#F8F8F8',
	'editorWidget.background': '#F8F8F8',
	'errorForeground': '#F85149',
	'focusBorder': '#005FB8',
	'foreground': '#3B3B3B',
	'icon.foreground': '#3B3B3B',
	'input.background': '#FFFFFF',
	'input.border': '#CECECE',
	'input.foreground': '#3B3B3B',
	'input.placeholderForeground': '#767676',
	'inputOption.activeBackground': '#BED6ED',
	'inputOption.activeBorder': '#005FB8',
	'inputOption.activeForeground': '#000000',
	'keybindingLabel.foreground': '#3B3B3B',
	'list.activeSelectionBackground': '#E8E8E8',
	'list.activeSelectionForeground': '#000000',
	'list.activeSelectionIconForeground': '#000000',
	'list.focusAndSelectionOutline': '#005FB8',
	'list.hoverBackground': '#F2F2F2',
	'menu.border': '#CECECE',
	'menu.selectionBackground': '#005FB8',
	'menu.selectionForeground': '#ffffff',
	'notebook.cellBorderColor': '#E5E5E5',
	'notebook.selectedCellBackground': '#C8DDF150',
	'notificationCenterHeader.background': '#FFFFFF',
	'notificationCenterHeader.foreground': '#3B3B3B',
	'notifications.background': '#FFFFFF',
	'notifications.border': '#E5E5E5',
	'notifications.foreground': '#3B3B3B',
	'panel.background': '#F8F8F8',
	'panel.border': '#E5E5E5',
	'panelInput.border': '#E5E5E5',
	'panelTitle.activeBorder': '#005FB8',
	'panelTitle.activeForeground': '#3B3B3B',
	'panelTitle.inactiveForeground': '#3B3B3B',
	'peekViewEditor.matchHighlightBackground': '#BB800966',
	'peekViewResult.background': '#FFFFFF',
	'peekViewResult.matchHighlightBackground': '#BB800966',
	'pickerGroup.border': '#E5E5E5',
	'pickerGroup.foreground': '#8B949E',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#005FB8',
	'quickInput.background': '#F8F8F8',
	'quickInput.foreground': '#3B3B3B',
	'searchEditor.textInputBorder': '#CECECE',
	'settings.dropdownBackground': '#FFFFFF',
	'settings.dropdownBorder': '#CECECE',
	'settings.headerForeground': '#1F1F1F',
	'settings.modifiedItemIndicator': '#BB800966',
	'settings.numberInputBorder': '#CECECE',
	'settings.textInputBorder': '#CECECE',
	'sideBar.background': '#F8F8F8',
	'sideBar.border': '#E5E5E5',
	'sideBar.foreground': '#3B3B3B',
	'sideBarSectionHeader.background': '#F8F8F8',
	'sideBarSectionHeader.border': '#E5E5E5',
	'sideBarSectionHeader.foreground': '#3B3B3B',
	'sideBarTitle.foreground': '#3B3B3B',
	'statusBar.background': '#F8F8F8',
	'statusBar.border': '#E5E5E5',
	'statusBar.debuggingBackground': '#FD716C',
	'statusBar.debuggingForeground': '#000000',
	'statusBar.focusBorder': '#005FB8',
	'statusBar.foreground': '#3B3B3B',
	'statusBar.noFolderBackground': '#F8F8F8',
	'statusBarItem.compactHoverBackground': '#CCCCCC',
	'statusBarItem.errorBackground': '#C72E0F',
	'statusBarItem.focusBorder': '#005FB8',
	'statusBarItem.hoverBackground': '#B8B8B850',
	'statusBarItem.prominentBackground': '#6E768166',
	'statusBarItem.remoteBackground': '#005FB8',
	'statusBarItem.remoteForeground': '#FFFFFF',
	'tab.activeBackground': '#FFFFFF',
	'tab.activeBorder': '#F8F8F8',
	'tab.activeBorderTop': '#005FB8',
	'tab.activeForeground': '#3B3B3B',
	'tab.border': '#E5E5E5',
	'tab.hoverBackground': '#FFFFFF',
	'tab.inactiveBackground': '#F8F8F8',
	'tab.inactiveForeground': '#868686',
	'tab.lastPinnedBorder': '#D4D4D4',
	'tab.selectedBackground': '#E4E6F1',
	'tab.selectedBorderTop': '#68a3da',
	'tab.selectedForeground': '#333333',
	'tab.unfocusedActiveBorder': '#F8F8F8',
	'tab.unfocusedActiveBorderTop': '#E5E5E5',
	'tab.unfocusedHoverBackground': '#F8F8F8',
	'terminal.foreground': '#3B3B3B',
	'terminal.inactiveSelectionBackground': '#E5EBF1',
	'terminal.tab.activeBorder': '#005FB8',
	'terminalCursor.foreground': '#005FB8',
	'textBlockQuote.background': '#F8F8F8',
	'textBlockQuote.border': '#E5E5E5',
	'textCodeBlock.background': '#F8F8F8',
	'textLink.activeForeground': '#005FB8',
	'textLink.foreground': '#005FB8',
	'textPreformat.background': '#0000001F',
	'textPreformat.foreground': '#3B3B3B',
	'textSeparator.foreground': '#21262D',
	'titleBar.activeBackground': '#F8F8F8',
	'titleBar.activeForeground': '#1E1E1E',
	'titleBar.border': '#E5E5E5',
	'titleBar.inactiveBackground': '#F8F8F8',
	'titleBar.inactiveForeground': '#8B949E',
	'welcomePage.tileBackground': '#F3F3F3',
	'widget.border': '#E5E5E5'
};

export interface IWorkbenchTheme {
	readonly id: string;
	readonly label: string;
	readonly extensionData?: ExtensionData;
	readonly description?: string;
	readonly settingsId: string | null;
}

export interface IWorkbenchColorTheme extends IWorkbenchTheme, IColorTheme {
	readonly settingsId: string;
	readonly tokenColors: ITextMateThemingRule[];
}

export interface IColorMap {
	[id: string]: Color;
}

export interface IWorkbenchFileIconTheme extends IWorkbenchTheme, IFileIconTheme {
}

export interface IWorkbenchProductIconTheme extends IWorkbenchTheme, IProductIconTheme {
	readonly settingsId: string;

	getIcon(icon: IconContribution): IconDefinition | undefined;
}

export type ThemeSettingTarget = ConfigurationTarget | undefined | 'auto' | 'preview';


export interface IWorkbenchThemeService extends IThemeService {
	readonly _serviceBrand: undefined;
	setColorTheme(themeId: string | undefined | IWorkbenchColorTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchColorTheme | null>;
	getColorTheme(): IWorkbenchColorTheme;
	/** Returns the selected theme and user customizations without window-local overlays. */
	getBaseColorTheme(): IWorkbenchColorTheme;
	getColorThemes(): Promise<IWorkbenchColorTheme[]>;
	getMarketplaceColorThemes(publisher: string, name: string, version: string): Promise<IWorkbenchColorTheme[]>;
	readonly onDidColorThemeChange: Event<IWorkbenchColorTheme>;

	/** Applies window-local colors computed from the base theme, without persisting them or changing the selected theme. */
	registerColorThemeOverlay(getColors: (theme: IWorkbenchColorTheme) => IColorMap): IDisposable;

	getPreferredColorScheme(): ColorScheme | undefined;

	setFileIconTheme(iconThemeId: string | undefined | IWorkbenchFileIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchFileIconTheme>;
	getFileIconTheme(): IWorkbenchFileIconTheme;
	getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]>;
	getMarketplaceFileIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchFileIconTheme[]>;
	readonly onDidFileIconThemeChange: Event<IWorkbenchFileIconTheme>;

	setProductIconTheme(iconThemeId: string | undefined | IWorkbenchProductIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchProductIconTheme>;
	getProductIconTheme(): IWorkbenchProductIconTheme;
	getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]>;
	getMarketplaceProductIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchProductIconTheme[]>;
	readonly onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme>;
}

export interface IThemeScopedColorCustomizations {
	[colorId: string]: string;
}

export interface IColorCustomizations {
	[colorIdOrThemeScope: string]: IThemeScopedColorCustomizations | string;
}

export interface IThemeScopedTokenColorCustomizations {
	[groupId: string]: ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface ITokenColorCustomizations {
	[groupIdOrThemeScope: string]: IThemeScopedTokenColorCustomizations | ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface IThemeScopedSemanticTokenColorCustomizations {
	[styleRule: string]: ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface ISemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedSemanticTokenColorCustomizations | ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface IThemeScopedExperimentalSemanticTokenColorCustomizations {
	[themeScope: string]: ISemanticTokenRules | undefined;
}

export interface IExperimentalSemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedExperimentalSemanticTokenColorCustomizations | ISemanticTokenRules | undefined;
}

export type IThemeScopedCustomizations =
	IThemeScopedColorCustomizations
	| IThemeScopedTokenColorCustomizations
	| IThemeScopedExperimentalSemanticTokenColorCustomizations
	| IThemeScopedSemanticTokenColorCustomizations;

export type IThemeScopableCustomizations =
	IColorCustomizations
	| ITokenColorCustomizations
	| IExperimentalSemanticTokenColorCustomizations
	| ISemanticTokenColorCustomizations;

export interface ISemanticTokenRules {
	[selector: string]: string | ISemanticTokenColorizationSetting | undefined;
}

export interface ITextMateThemingRule {
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}

export interface ITokenColorizationSetting {
	foreground?: string;
	background?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	fontFamily?: string;
	fontSize?: number;
	lineHeight?: number;
}

export interface ISemanticTokenColorizationSetting {
	foreground?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	italic?: boolean;
}

export interface ExtensionData {
	extensionId: string;
	extensionPublisher: string;
	extensionName: string;
	extensionIsBuiltin: boolean;
}

export namespace ExtensionData {
	export function toJSONObject(d: ExtensionData | undefined): any {
		return d && { _extensionId: d.extensionId, _extensionIsBuiltin: d.extensionIsBuiltin, _extensionName: d.extensionName, _extensionPublisher: d.extensionPublisher };
	}
	export function fromJSONObject(o: any): ExtensionData | undefined {
		if (o && isString(o._extensionId) && isBoolean(o._extensionIsBuiltin) && isString(o._extensionName) && isString(o._extensionPublisher)) {
			return { extensionId: o._extensionId, extensionIsBuiltin: o._extensionIsBuiltin, extensionName: o._extensionName, extensionPublisher: o._extensionPublisher };
		}
		return undefined;
	}
	export function fromName(publisher: string, name: string, isBuiltin = false): ExtensionData {
		return { extensionPublisher: publisher, extensionId: `${publisher}.${name}`, extensionName: name, extensionIsBuiltin: isBuiltin };
	}
}

export interface IThemeExtensionPoint {
	id: string;
	label?: string;
	description?: string;
	path: string;
	uiTheme?: ThemeTypeSelector;
	_watch: boolean; // unsupported options to watch location
}
