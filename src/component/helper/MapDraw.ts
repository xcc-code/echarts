/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/

import * as zrUtil from 'zrender/src/core/util';
import RoamController from './RoamController';
import * as roamHelper from '../../component/helper/roamHelper';
import {onIrrelevantElement} from '../../component/helper/cursorHelper';
import * as graphic from '../../util/graphic';
import {
    enableHoverEmphasis,
    enableComponentHighDownFeatures,
    setDefaultStateProxy
} from '../../util/states';
import geoSourceManager from '../../coord/geo/geoSourceManager';
import {getUID} from '../../util/component';
import ExtensionAPI from '../../core/ExtensionAPI';
import GeoModel, { GeoCommonOptionMixin, GeoItemStyleOption } from '../../coord/geo/GeoModel';
import MapSeries from '../../chart/map/MapSeries';
import GlobalModel from '../../model/Global';
import { Payload, ECElement, LineStyleOption, InnerFocus, DisplayState } from '../../util/types';
import GeoView from '../geo/GeoView';
import MapView from '../../chart/map/MapView';
import Geo from '../../coord/geo/Geo';
import Model from '../../model/Model';
import { setLabelStyle, getLabelStatesModels } from '../../label/labelStyle';
import { getECData } from '../../util/innerStore';
import { createOrUpdatePatternFromDecal } from '../../util/decal';
import { makeInner } from '../../util/model';
import ZRText, {TextStyleProps} from 'zrender/src/graphic/Text';
import { ViewCoordSysTransformInfoPart } from '../../coord/View';
import { GeoSVGGraphicRecord, GeoSVGResource } from '../../coord/geo/GeoSVGResource';
import Displayable from 'zrender/src/graphic/Displayable';
import Element from 'zrender/src/Element';
import List from '../../data/List';
import { GeoJSONRegion } from '../../coord/geo/Region';
import { SVGNodeTagLower } from 'zrender/src/tool/parseSVG';

const mapLabelTransform = makeInner<{
    x: number
    y: number
}, ZRText>();

interface RegionsGroup extends graphic.Group {
}

type RegionModel = ReturnType<GeoModel['getRegionModel']> | ReturnType<MapSeries['getRegionModel']>;

type MapOrGeoModel = GeoModel | MapSeries;

interface ViewBuildContext {
    api: ExtensionAPI;
    geo: Geo;
    mapOrGeoModel: GeoModel | MapSeries;
    data: List;
    isVisualEncodedByVisualMap: boolean;
    isGeo: boolean;
    transformInfoRaw: ViewCoordSysTransformInfoPart;
}

interface GeoStyleableOption {
    itemStyle?: GeoItemStyleOption;
    lineStyle?: LineStyleOption;
}
type RegionName = string;

/**
 * Only these tags enable use `itemStyle` if they are named in SVG.
 * Other tags like <text> <tspan> <image> might not suitable for `itemStyle`.
 * They will not be considered to be styled until some requirements come.
 */
const OPTION_STYLE_ENABLED_TAGS: SVGNodeTagLower[] = [
    'rect', 'circle', 'line', 'ellipse', 'polygon', 'polyline', 'path'
];
const OPTION_STYLE_ENABLED_TAG_MAP = zrUtil.createHashMap<number, SVGNodeTagLower>(
    OPTION_STYLE_ENABLED_TAGS
);
const STATE_TRIGGER_TAG_MAP = zrUtil.createHashMap<number, SVGNodeTagLower>(
    OPTION_STYLE_ENABLED_TAGS.concat(['g']) as SVGNodeTagLower[]
);
const LABEL_HOST_MAP = zrUtil.createHashMap<number, SVGNodeTagLower>(
    OPTION_STYLE_ENABLED_TAGS.concat(['g']) as SVGNodeTagLower[]
);


function getFixedItemStyle(model: Model<GeoItemStyleOption>) {
    const itemStyle = model.getItemStyle();
    const areaColor = model.get('areaColor');

    // If user want the color not to be changed when hover,
    // they should both set areaColor and color to be null.
    if (areaColor != null) {
        itemStyle.fill = areaColor;
    }

    return itemStyle;
}
class MapDraw {

    private uid: string;

    private _controller: RoamController;

    private _controllerHost: {
        target: graphic.Group;
        zoom?: number;
        zoomLimit?: GeoCommonOptionMixin['scaleLimit'];
    };

    readonly group: graphic.Group;


    /**
     * This flag is used to make sure that only one among
     * `pan`, `zoom`, `click` can occurs, otherwise 'selected'
     * action may be triggered when `pan`, which is unexpected.
     */
    private _mouseDownFlag: boolean;

    private _regionsGroup: RegionsGroup;

    private _regionsGroupByName: zrUtil.HashMap<RegionsGroup>;

    private _svgMapName: string;

    private _svgGroup: graphic.Group;

    private _svgGraphicRecord: GeoSVGGraphicRecord;

    // A name may correspond to multiple graphics.
    // Used as event dispatcher.
    private _svgDispatcherMap: zrUtil.HashMap<Element[], RegionName>;


    constructor(api: ExtensionAPI) {
        const group = new graphic.Group();
        this.uid = getUID('ec_map_draw');
        this._controller = new RoamController(api.getZr());
        this._controllerHost = { target: group };
        this.group = group;

        group.add(this._regionsGroup = new graphic.Group() as RegionsGroup);
        group.add(this._svgGroup = new graphic.Group());
    }

    draw(
        mapOrGeoModel: GeoModel | MapSeries,
        ecModel: GlobalModel,
        api: ExtensionAPI,
        fromView: MapView | GeoView,
        payload: Payload
    ): void {

        const isGeo = mapOrGeoModel.mainType === 'geo';

        // Map series has data. GEO model that controlled by map series
        // will be assigned with map data. Other GEO model has no data.
        let data = (mapOrGeoModel as MapSeries).getData && (mapOrGeoModel as MapSeries).getData();
        isGeo && ecModel.eachComponent({mainType: 'series', subType: 'map'}, function (mapSeries: MapSeries) {
            if (!data && mapSeries.getHostGeoModel() === mapOrGeoModel) {
                data = mapSeries.getData();
            }
        });

        const geo = mapOrGeoModel.coordinateSystem;

        const regionsGroup = this._regionsGroup;
        const group = this.group;

        const transformInfo = geo.getTransformInfo();
        const transformInfoRaw = transformInfo.raw;
        const transformInfoRoam = transformInfo.roam;

        // No animation when first draw or in action
        const isFirstDraw = !regionsGroup.childAt(0) || payload;

        if (isFirstDraw) {
            group.x = transformInfoRoam.x;
            group.y = transformInfoRoam.y;
            group.scaleX = transformInfoRoam.scaleX;
            group.scaleY = transformInfoRoam.scaleY;
            group.dirty();
        }
        else {
            graphic.updateProps(group, transformInfoRoam, mapOrGeoModel);
        }

        const isVisualEncodedByVisualMap = data
            && data.getVisual('visualMeta')
            && data.getVisual('visualMeta').length > 0;

        const viewBuildCtx = {
            api,
            geo,
            mapOrGeoModel,
            data,
            isVisualEncodedByVisualMap,
            isGeo,
            transformInfoRaw
        };

        if (geo.resourceType === 'geoJSON') {
            this._buildGeoJSON(viewBuildCtx);
        }
        else if (geo.resourceType === 'geoSVG') {
            this._buildSVG(viewBuildCtx);
        }

        this._updateController(mapOrGeoModel, ecModel, api);

        this._updateMapSelectHandler(mapOrGeoModel, regionsGroup, api, fromView);
    }

    private _buildGeoJSON(viewBuildCtx: ViewBuildContext): void {
        const nameMap = this._regionsGroupByName = zrUtil.createHashMap<RegionsGroup>();
        const regionsGroup = this._regionsGroup;
        const transformInfoRaw = viewBuildCtx.transformInfoRaw;
        const mapOrGeoModel = viewBuildCtx.mapOrGeoModel;
        const data = viewBuildCtx.data;

        const transformPoint = function (point: number[]): number[] {
            return [
                point[0] * transformInfoRaw.scaleX + transformInfoRaw.x,
                point[1] * transformInfoRaw.scaleY + transformInfoRaw.y
            ];
        };

        regionsGroup.removeAll();

        // Only when the resource is GeoJSON, there is `geo.regions`.
        zrUtil.each(viewBuildCtx.geo.regions, function (region: GeoJSONRegion) {
            const regionName = region.name;
            const regionModel = mapOrGeoModel.getRegionModel(regionName);
            const dataIdx = data ? data.indexOfName(regionName) : null;

            // Consider in GeoJson properties.name may be duplicated, for example,
            // there is multiple region named "United Kindom" or "France" (so many
            // colonies). And it is not appropriate to merge them in geo, which
            // will make them share the same label and bring trouble in label
            // location calculation.
            let regionGroup = nameMap.get(regionName);

            if (!regionGroup) {
                regionGroup = nameMap.set(regionName, new graphic.Group() as RegionsGroup);
                regionsGroup.add(regionGroup);

                resetEventTriggerForRegion(
                    viewBuildCtx, regionGroup, regionName, regionModel, mapOrGeoModel, dataIdx
                );
                resetTooltipForRegion(
                    viewBuildCtx, regionGroup, regionName, regionModel, mapOrGeoModel
                );
                resetStateTriggerForRegion(
                    viewBuildCtx, regionGroup, regionName, regionModel, mapOrGeoModel
                );
            }

            const compoundPath = new graphic.CompoundPath({
                segmentIgnoreThreshold: 1,
                shape: {
                    paths: []
                }
            });
            regionGroup.add(compoundPath);

            zrUtil.each(region.geometries, function (geometry) {
                if (geometry.type !== 'polygon') {
                    return;
                }
                const points = [];
                for (let i = 0; i < geometry.exterior.length; ++i) {
                    points.push(transformPoint(geometry.exterior[i]));
                }
                compoundPath.shape.paths.push(new graphic.Polygon({
                    segmentIgnoreThreshold: 1,
                    shape: {
                        points: points
                    }
                }));

                for (let i = 0; i < (geometry.interiors ? geometry.interiors.length : 0); ++i) {
                    const interior = geometry.interiors[i];
                    const points = [];
                    for (let j = 0; j < interior.length; ++j) {
                        points.push(transformPoint(interior[j]));
                    }
                    compoundPath.shape.paths.push(new graphic.Polygon({
                        segmentIgnoreThreshold: 1,
                        shape: {
                            points: points
                        }
                    }));
                }
            });

            applyOptionStyleForRegion(
                viewBuildCtx, compoundPath, dataIdx, regionModel
            );

            if (compoundPath instanceof Displayable) {
                compoundPath.culling = true;
            }

            const centerPt = transformPoint(region.getCenter());
            resetLabelForRegion(
                viewBuildCtx, compoundPath, regionName, regionModel, mapOrGeoModel, dataIdx, centerPt
            );

        }, this);
    }

    private _buildSVG(viewBuildCtx: ViewBuildContext): void {
        const mapName = viewBuildCtx.geo.map;
        const transformInfoRaw = viewBuildCtx.transformInfoRaw;

        this._svgGroup.x = transformInfoRaw.x;
        this._svgGroup.y = transformInfoRaw.y;
        this._svgGroup.scaleX = transformInfoRaw.scaleX;
        this._svgGroup.scaleY = transformInfoRaw.scaleY;

        if (this._svgResourceChanged(mapName)) {
            this._freeSVG();
            this._useSVG(mapName);
        }

        const svgDispatcherMap = this._svgDispatcherMap = zrUtil.createHashMap<Element[], RegionName>();

        let focusSelf = false;
        zrUtil.each(this._svgGraphicRecord.named, function (namedItem) {
            // Note that we also allow different elements have the same name.
            // For example, a glyph of a city and the label of the city have
            // the same name and their tooltip info can be defined in a single
            // region option.

            const regionName = namedItem.name;
            const mapOrGeoModel = viewBuildCtx.mapOrGeoModel;
            const data = viewBuildCtx.data;
            const svgNodeTagLower = namedItem.svgNodeTagLower;
            const el = namedItem.el;

            const dataIdx = data ? data.indexOfName(regionName) : null;
            const regionModel = mapOrGeoModel.getRegionModel(regionName);

            if (OPTION_STYLE_ENABLED_TAG_MAP.get(svgNodeTagLower) != null
                && (el instanceof Displayable)
            ) {
                applyOptionStyleForRegion(viewBuildCtx, el, dataIdx, regionModel);
            }

            if (el instanceof Displayable) {
                el.culling = true;
            }

            // We do not know how the SVG like so we'd better not to change z2.
            // Otherwise it might bring some unexpected result. For example,
            // an area hovered that make some inner city can not be clicked.
            (el as ECElement).z2EmphasisLift = 0;

            // If self named, that is, if tag is inside a named <g> (where `namedFrom` does not exists):
            if (!namedItem.namedFrom) {
                // label should batter to be displayed based on the center of <g>
                // if it is named rather than displayed on each child.
                if (LABEL_HOST_MAP.get(svgNodeTagLower) != null) {
                    resetLabelForRegion(
                        viewBuildCtx, el, regionName, regionModel, mapOrGeoModel, dataIdx, null
                    );
                }

                resetEventTriggerForRegion(
                    viewBuildCtx, el, regionName, regionModel, mapOrGeoModel, dataIdx
                );

                resetTooltipForRegion(
                    viewBuildCtx, el, regionName, regionModel, mapOrGeoModel
                );

                if (STATE_TRIGGER_TAG_MAP.get(svgNodeTagLower) != null) {
                    const focus = resetStateTriggerForRegion(
                        viewBuildCtx, el, regionName, regionModel, mapOrGeoModel
                    );
                    if (focus === 'self') {
                        focusSelf = true;
                    }
                    const els = svgDispatcherMap.get(regionName) || svgDispatcherMap.set(regionName, []);
                    els.push(el);
                }
            }

        }, this);

        this._enableBlurEntireSVG(focusSelf, viewBuildCtx);
    }

    private _enableBlurEntireSVG(
        focusSelf: boolean,
        viewBuildCtx: ViewBuildContext
    ): void {
        // It's a little complicated to support blurring the entire geoSVG in series-map.
        // So do not suport it until some requirements come.
        // At present, in series-map, only regions can be blurred.
        if (focusSelf && viewBuildCtx.isGeo) {
            const blurStyle = (viewBuildCtx.mapOrGeoModel as GeoModel).getModel(['blur', 'itemStyle']).getItemStyle();
            // Only suport `opacity` here. Because not sure that other props are suitable for
            // all of the elements generated by SVG (especially for Text/TSpan/Image/... ).
            const opacity = blurStyle.opacity;
            this._svgGraphicRecord.root.traverse(el => {
                if (!el.isGroup) {
                    // PENDING: clear those settings to SVG elements when `_freeSVG`.
                    // (Currently it happen not to be needed.)
                    setDefaultStateProxy(el as Displayable);
                    const style = (el as Displayable).ensureState('blur').style || {};
                    // Do not overwrite the region style that already set from region option.
                    if (style.opacity == null && opacity != null) {
                        style.opacity = opacity;
                    }
                    // If `ensureState('blur').style = {}`, there will be default opacity.

                    // Enable `stateTransition` (animation).
                    (el as Displayable).ensureState('emphasis');
                }
            });
        }
    }

    remove(): void {
        this._regionsGroup.removeAll();
        this._regionsGroupByName = null;
        this._svgGroup.removeAll();
        this._freeSVG();
        this._controller.dispose();
        this._controllerHost = null;
    }

    findHighDownDispatchers(name: string, geoModel: GeoModel): Element[] {
        if (name == null) {
            return [];
        }

        const geo = geoModel.coordinateSystem;

        if (geo.resourceType === 'geoJSON') {
            const regionsGroupByName = this._regionsGroupByName;
            if (regionsGroupByName) {
                const regionGroup = regionsGroupByName.get(name);
                return regionGroup ? [regionGroup] : [];
            }
        }
        else if (geo.resourceType === 'geoSVG') {
            return this._svgDispatcherMap && this._svgDispatcherMap.get(name) || [];
        }
    }

    private _svgResourceChanged(mapName: string): boolean {
        return this._svgMapName !== mapName;
    }

    private _useSVG(mapName: string): void {
        const resource = geoSourceManager.getGeoResource(mapName);
        if (resource && resource.type === 'geoSVG') {
            const svgGraphic = (resource as GeoSVGResource).useGraphic(this.uid);
            this._svgGroup.add(svgGraphic.root);
            this._svgGraphicRecord = svgGraphic;
            this._svgMapName = mapName;
        }
    }

    private _freeSVG(): void {
        const mapName = this._svgMapName;
        if (mapName == null) {
            return;
        }

        const resource = geoSourceManager.getGeoResource(mapName);
        if (resource && resource.type === 'geoSVG') {
            (resource as GeoSVGResource).freeGraphic(this.uid);
        }
        this._svgGraphicRecord = null;
        this._svgDispatcherMap = null;
        this._svgGroup.removeAll();
        this._svgMapName = null;
    }

    private _updateController(
        this: MapDraw, mapOrGeoModel: GeoModel | MapSeries, ecModel: GlobalModel, api: ExtensionAPI
    ): void {
        const geo = mapOrGeoModel.coordinateSystem;
        const controller = this._controller;
        const controllerHost = this._controllerHost;

        // @ts-ignore FIXME:TS
        controllerHost.zoomLimit = mapOrGeoModel.get('scaleLimit');
        controllerHost.zoom = geo.getZoom();

        // roamType is will be set default true if it is null
        // @ts-ignore FIXME:TS
        controller.enable(mapOrGeoModel.get('roam') || false);
        const mainType = mapOrGeoModel.mainType;

        function makeActionBase(): Payload {
            const action = {
                type: 'geoRoam',
                componentType: mainType
            } as Payload;
            action[mainType + 'Id'] = mapOrGeoModel.id;
            return action;
        }

        const updateLabelTransforms = () => {
            const group = this.group;
            this._regionsGroup.traverse(function (el) {
                const textContent = el.getTextContent();
                if (textContent) {
                    el.setTextConfig({
                        local: true
                    });
                    textContent.x = mapLabelTransform(textContent).x || 0;
                    textContent.y = mapLabelTransform(textContent).y || 0;
                    textContent.scaleX = 1 / group.scaleX;
                    textContent.scaleY = 1 / group.scaleY;
                    textContent.markRedraw();
                }
            });
        };

        controller.off('pan').on('pan', function (e) {
            this._mouseDownFlag = false;

            roamHelper.updateViewOnPan(controllerHost, e.dx, e.dy);

            updateLabelTransforms();

            api.dispatchAction(zrUtil.extend(makeActionBase(), {
                dx: e.dx,
                dy: e.dy
            }));
        }, this);

        controller.off('zoom').on('zoom', function (e) {
            this._mouseDownFlag = false;

            roamHelper.updateViewOnZoom(controllerHost, e.scale, e.originX, e.originY);

            updateLabelTransforms();

            api.dispatchAction(zrUtil.extend(makeActionBase(), {
                zoom: e.scale,
                originX: e.originX,
                originY: e.originY
            }));

        }, this);

        controller.setPointerChecker(function (e, x, y) {
            return geo.containPoint([x, y])
                && !onIrrelevantElement(e, api, mapOrGeoModel);
        });
    }

    private _updateMapSelectHandler(
        mapOrGeoModel: GeoModel | MapSeries,
        regionsGroup: RegionsGroup,
        api: ExtensionAPI,
        fromView: MapView | GeoView
    ): void {
        const mapDraw = this;

        regionsGroup.off('mousedown');
        regionsGroup.off('click');

        // @ts-ignore FIXME:TS resolve type conflict
        if (mapOrGeoModel.get('selectedMode')) {

            regionsGroup.on('mousedown', function () {
                mapDraw._mouseDownFlag = true;
            });

            regionsGroup.on('click', function (e) {
                if (!mapDraw._mouseDownFlag) {
                    return;
                }
                mapDraw._mouseDownFlag = false;
            });
        }
    }

};

function labelTextAfterUpdate(this: graphic.Text) {
    // Make the label text apply only translate of this host el
    // but no other transform like scale,rotation of this host el.
    const mt = this.transform;
    mt[0] = 1;
    mt[1] = 0;
    mt[2] = 0;
    mt[3] = 1;
}

function applyOptionStyleForRegion(
    viewBuildCtx: ViewBuildContext,
    el: Displayable,
    dataIndex: number,
    regionModel: Model<
        GeoStyleableOption & {
            emphasis?: GeoStyleableOption;
            select?: GeoStyleableOption;
            blur?: GeoStyleableOption;
        }
    >
): void {
    // All of the path are using `itemStyle`, becuase
    // (1) Some SVG also use fill on polyline (The different between
    // polyline and polygon is "open" or "close" but not fill or not).
    // (2) For the common props like opacity, if some use itemStyle
    // and some use `lineStyle`, it might confuse users.
    // (3) Most SVG use <path>, where can not detect wether draw a "line"
    // or a filled shape, so use `itemStyle` for <path>.

    const normalStyleModel = regionModel.getModel('itemStyle');
    const emphasisStyleModel = regionModel.getModel(['emphasis', 'itemStyle']);
    const blurStyleModel = regionModel.getModel(['blur', 'itemStyle']);
    const selectStyleModel = regionModel.getModel(['select', 'itemStyle']);

    // NOTE: DONT use 'style' in visual when drawing map.
    // This component is used for drawing underlying map for both geo component and map series.
    const normalStyle = getFixedItemStyle(normalStyleModel);
    const emphasisStyle = getFixedItemStyle(emphasisStyleModel);
    const selectStyle = getFixedItemStyle(selectStyleModel);
    const blurStyle = getFixedItemStyle(blurStyleModel);

    // Update the itemStyle if has data visual
    const data = viewBuildCtx.data;
    if (data) {
        // Only visual color of each item will be used. It can be encoded by visualMap
        // But visual color of series is used in symbol drawing

        // Visual color for each series is for the symbol draw
        const style = data.getItemVisual(dataIndex, 'style');
        const decal = data.getItemVisual(dataIndex, 'decal');
        if (viewBuildCtx.isVisualEncodedByVisualMap && style.fill) {
            normalStyle.fill = style.fill;
        }
        if (decal) {
            normalStyle.decal = createOrUpdatePatternFromDecal(decal, viewBuildCtx.api);
        }
    }

    // SVG text, tspan and image can be named but not supporeted
    // to be styled by region option yet.
    el.setStyle(normalStyle);
    el.style.strokeNoScale = true;
    el.ensureState('emphasis').style = emphasisStyle;
    el.ensureState('select').style = selectStyle;
    el.ensureState('blur').style = blurStyle;

    // Enable blur
    setDefaultStateProxy(el);
}

function resetLabelForRegion(
    viewBuildCtx: ViewBuildContext,
    el: Element,
    regionName: string,
    regionModel: RegionModel,
    mapOrGeoModel: MapOrGeoModel,
    // Exist only if `viewBuildCtx.data` exists.
    dataIdx: number,
    // If labelXY not provided, use `textConfig.position: 'inside'`
    labelXY: number[]
): void {
    const data = viewBuildCtx.data;
    const isGeo = viewBuildCtx.isGeo;

    const isDataNaN = data && isNaN(data.get(data.mapDimension('value'), dataIdx) as number);
    const itemLayout = data && data.getItemLayout(dataIdx);

    // In the following cases label will be drawn
    // 1. In map series and data value is NaN
    // 2. In geo component
    // 3. Region has no series legendSymbol, which will be add a showLabel flag in mapSymbolLayout
    if (
        ((isGeo || isDataNaN))
        || (itemLayout && itemLayout.showLabel)
    ) {

        const query = !isGeo ? dataIdx : regionName;
        let labelFetcher;

        // Consider dataIdx not found.
        if (!data || dataIdx >= 0) {
            labelFetcher = mapOrGeoModel;
        }

        const specifiedTextOpt: Partial<Record<DisplayState, TextStyleProps>> = labelXY ? {
            normal: {
                align: 'center',
                verticalAlign: 'middle'
            }
        } : null;

        // Caveat: must be called after `setDefaultStateProxy(el);` called.
        // because textContent will be assign with `el.stateProxy` inside.
        setLabelStyle<typeof query>(
            el,
            getLabelStatesModels(regionModel),
            {
                labelFetcher: labelFetcher,
                labelDataIndex: query,
                defaultText: regionName
            },
            specifiedTextOpt
        );

        const textEl = el.getTextContent();
        if (textEl) {
            mapLabelTransform(textEl).x = textEl.x = labelXY ? labelXY[0] : 0;
            mapLabelTransform(textEl).y = textEl.y = labelXY ? labelXY[1] : 0;
            textEl.z2 = 10;
            textEl.afterUpdate = labelTextAfterUpdate;
        }

        // Need to apply the `translate`.
        if (el.textConfig) {
            el.textConfig.local = true;
            if (labelXY) {
                el.textConfig.position = null;
            }
        }

        (el as ECElement).disableLabelAnimation = true;
    }
    else {
        el.removeTextContent();
        el.removeTextConfig();
        (el as ECElement).disableLabelAnimation = null;
    }
}

function resetEventTriggerForRegion(
    viewBuildCtx: ViewBuildContext,
    eventTrigger: Element,
    regionName: string,
    regionModel: RegionModel,
    mapOrGeoModel: MapOrGeoModel,
    // Exist only if `viewBuildCtx.data` exists.
    dataIdx: number
): void {
    // setItemGraphicEl, setHoverStyle after all polygons and labels
    // are added to the rigionGroup
    if (viewBuildCtx.data) {
        // FIXME: when series-map use a SVG map, and there are duplicated name specified
        // on different SVG elements, after `data.setItemGraphicEl(...)`:
        // (1) all of them will be mounted with `dataIndex`, `seriesIndex`, so that tooltip
        // can be triggered only mouse hover. That's correct.
        // (2) only the last element will be kept in `data`, so that if trigger tooltip
        // by `dispatchAction`, only the last one can be found and triggered. That might be
        // not correct. We will fix it in future if anyone demanding that.
        viewBuildCtx.data.setItemGraphicEl(dataIdx, eventTrigger);
    }
    // series-map will not trigger "geoselectchange" no matter it is
    // based on a declared geo component. Becuause series-map will
    // trigger "selectchange". If it trigger both the two events,
    // If users call `chart.dispatchAction({type: 'toggleSelect'})`,
    // it not easy to also fire event "geoselectchanged".
    else {
        // Package custom mouse event for geo component
        getECData(eventTrigger).eventData = {
            componentType: 'geo',
            componentIndex: mapOrGeoModel.componentIndex,
            geoIndex: mapOrGeoModel.componentIndex,
            name: regionName,
            region: (regionModel && regionModel.option) || {}
        };
    }
}

function resetTooltipForRegion(
    viewBuildCtx: ViewBuildContext,
    el: Element,
    regionName: string,
    regionModel: RegionModel,
    mapOrGeoModel: MapOrGeoModel
): void {
    if (!viewBuildCtx.data) {
        graphic.setTooltipConfig({
            el: el,
            componentModel: mapOrGeoModel,
            itemName: regionName,
            // @ts-ignore FIXME:TS fix the "compatible with each other"?
            itemTooltipOption: regionModel.get('tooltip')
        });
    }
}

function resetStateTriggerForRegion(
    viewBuildCtx: ViewBuildContext,
    el: Element,
    regionName: string,
    regionModel: RegionModel,
    mapOrGeoModel: MapOrGeoModel
): InnerFocus {
    // @ts-ignore FIXME:TS fix the "compatible with each other"?
    el.highDownSilentOnTouch = !!mapOrGeoModel.get('selectedMode');
    // @ts-ignore FIXME:TS fix the "compatible with each other"?
    const emphasisModel = regionModel.getModel('emphasis');
    const focus = emphasisModel.get('focus');
    enableHoverEmphasis(
        el, focus, emphasisModel.get('blurScope')
    );
    if (viewBuildCtx.isGeo) {
        enableComponentHighDownFeatures(el, mapOrGeoModel as GeoModel, regionName);
    }

    return focus;
}

export default MapDraw;


// @ts-ignore FIXME:TS fix the "compatible with each other"?
