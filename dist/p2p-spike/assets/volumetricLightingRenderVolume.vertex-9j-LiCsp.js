import{S as o}from"./main-CVBV0X5x.js";import"./index-BFuBUqOC.js";const e="volumetricLightingRenderVolumeVertexShader",r=`#include<__decl__sceneVertex>
#include<__decl__meshVertex>
attribute vec3 position;varying vec4 vWorldPos;void main(void) {vec4 worldPos=world*vec4(position,1.0);vWorldPos=worldPos;gl_Position=viewProjection*worldPos;}
`;o.ShadersStore[e]||(o.ShadersStore[e]=r);const d={name:e,shader:r};export{d as volumetricLightingRenderVolumeVertexShader};
