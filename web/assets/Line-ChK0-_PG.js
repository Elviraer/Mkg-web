import{i as e}from"./rolldown-runtime-aKtaBQYM.js";import{i as t,n}from"./react-vendor-DMETq0mH.js";import{A as r,At as i,C as a,Jt as o,Kt as s,N as c,Pt as l,Q as u,Qt as d,Ut as f,Wt as p,a as m,et as h,ht as g,k as _,mt as v,p as ee,qt as y,tt as b,z as x}from"./three.module-B3_K-_Pj.js";import{i as te,o as S}from"./react-three-fiber.esm-C_FlHjNi.js";function C(){return C=Object.assign?Object.assign.bind():function(e){for(var t=1;t<arguments.length;t++){var n=arguments[t];for(var r in n)({}).hasOwnProperty.call(n,r)&&(e[r]=n[r])}return e},C.apply(null,arguments)}var w=e(t()),ne=e(n()),T=new y,E=new y,D=new y,O=new s;function re(e,t,n){let r=T.setFromMatrixPosition(e.matrixWorld);r.project(t);let i=n.width/2,a=n.height/2;return[r.x*i+i,-(r.y*a)+a]}function ie(e,t){let n=T.setFromMatrixPosition(e.matrixWorld),r=E.setFromMatrixPosition(t.matrixWorld),i=n.sub(r),a=t.getWorldDirection(D);return i.angleTo(a)>Math.PI/2}function ae(e,t,n,r){let i=T.setFromMatrixPosition(e.matrixWorld),a=i.clone();a.project(t),O.set(a.x,a.y),n.setFromCamera(O,t);let o=n.intersectObjects(r,!0);if(o.length){let e=o[0].distance;return i.distanceTo(n.ray.origin)<e}return!0}function oe(e,t){if(t instanceof v)return t.zoom;if(t instanceof g){let n=T.setFromMatrixPosition(e.matrixWorld),r=E.setFromMatrixPosition(t.matrixWorld),i=t.fov*Math.PI/180,a=n.distanceTo(r);return 1/(2*Math.tan(i/2)*a)}else return 1}function se(e,t,n){if(t instanceof g||t instanceof v){let r=T.setFromMatrixPosition(e.matrixWorld),i=E.setFromMatrixPosition(t.matrixWorld),a=r.distanceTo(i),o=(n[1]-n[0])/(t.far-t.near),s=n[1]-o*t.far;return Math.round(o*a+s)}}var k=e=>Math.abs(e)<1e-10?0:e;function A(e,t,n=``){let r=`matrix3d(`;for(let n=0;n!==16;n++)r+=k(t[n]*e.elements[n])+(n===15?`)`:`,`);return n+r}var ce=(e=>t=>A(t,e))([1,-1,1,1,1,-1,1,1,1,-1,1,1,1,-1,1,1]),le=(e=>(t,n)=>A(t,e(n),`translate(-50%,-50%)`))(e=>[1/e,1/e,1/e,1,-1/e,-1/e,-1/e,-1,1/e,1/e,1/e,1,1,1,1,1]);function ue(e){return e&&typeof e==`object`&&`current`in e}var j=w.forwardRef(({children:e,eps:t=.001,style:n,className:r,prepend:i,center:a,fullscreen:o,portal:s,distanceFactor:c,sprite:l=!1,transform:u=!1,occlude:d,onOcclude:f,castShadow:p,receiveShadow:m,material:h,geometry:g,zIndexRange:_=[16777271,0],calculatePosition:v=re,as:ee=`div`,wrapperClass:b,pointerEvents:x=`auto`,...T},E)=>{let{gl:D,camera:O,scene:A,size:j,raycaster:M,events:N,viewport:P}=S(),[F]=w.useState(()=>document.createElement(ee)),I=w.useRef(),L=w.useRef(null),R=w.useRef(0),z=w.useRef([0,0]),B=w.useRef(null),V=w.useRef(null),H=s?.current||N.connected||D.domElement.parentNode,U=w.useRef(null),W=w.useRef(!1),G=w.useMemo(()=>d&&d!==`blending`||Array.isArray(d)&&d.length&&ue(d[0]),[d]);w.useLayoutEffect(()=>{let e=D.domElement;d&&d===`blending`?(e.style.zIndex=`${Math.floor(_[0]/2)}`,e.style.position=`absolute`,e.style.pointerEvents=`none`):(e.style.zIndex=null,e.style.position=null,e.style.pointerEvents=null)},[d]),w.useLayoutEffect(()=>{if(L.current){let e=I.current=ne.createRoot(F);if(A.updateMatrixWorld(),u)F.style.cssText=`position:absolute;top:0;left:0;pointer-events:none;overflow:hidden;`;else{let e=v(L.current,O,j);F.style.cssText=`position:absolute;top:0;left:0;transform:translate3d(${e[0]}px,${e[1]}px,0);transform-origin:0 0;`}return H&&(i?H.prepend(F):H.appendChild(F)),()=>{H&&H.removeChild(F),e.unmount()}}},[H,u]),w.useLayoutEffect(()=>{b&&(F.className=b)},[b]);let K=w.useMemo(()=>u?{position:`absolute`,top:0,left:0,width:j.width,height:j.height,transformStyle:`preserve-3d`,pointerEvents:`none`}:{position:`absolute`,transform:a?`translate3d(-50%,-50%,0)`:`none`,...o&&{top:-j.height/2,left:-j.width/2,width:j.width,height:j.height},...n},[n,a,o,j,u]),q=w.useMemo(()=>({position:`absolute`,pointerEvents:x}),[x]);w.useLayoutEffect(()=>{if(W.current=!1,u){var t;(t=I.current)==null||t.render(w.createElement(`div`,{ref:B,style:K},w.createElement(`div`,{ref:V,style:q},w.createElement(`div`,{ref:E,className:r,style:n,children:e}))))}else{var i;(i=I.current)==null||i.render(w.createElement(`div`,{ref:E,style:K,className:r,children:e}))}});let J=w.useRef(!0);te(e=>{if(L.current){O.updateMatrixWorld(),L.current.updateWorldMatrix(!0,!1);let e=u?z.current:v(L.current,O,j);if(u||Math.abs(R.current-O.zoom)>t||Math.abs(z.current[0]-e[0])>t||Math.abs(z.current[1]-e[1])>t){let t=ie(L.current,O),n=!1;G&&(Array.isArray(d)?n=d.map(e=>e.current):d!==`blending`&&(n=[A]));let r=J.current;if(n){let e=ae(L.current,O,M,n);J.current=e&&!t}else J.current=!t;r!==J.current&&(f?f(!J.current):F.style.display=J.current?`block`:`none`);let i=Math.floor(_[0]/2),a=d?G?[_[0],i]:[i-1,0]:_;if(F.style.zIndex=`${se(L.current,O,a)}`,u){let[e,t]=[j.width/2,j.height/2],n=O.projectionMatrix.elements[5]*t,{isOrthographicCamera:r,top:i,left:a,bottom:o,right:s}=O,u=ce(O.matrixWorldInverse),d=r?`scale(${n})translate(${k(-(s+a)/2)}px,${k((i+o)/2)}px)`:`translateZ(${n}px)`,f=L.current.matrixWorld;l&&(f=O.matrixWorldInverse.clone().transpose().copyPosition(f).scale(L.current.scale),f.elements[3]=f.elements[7]=f.elements[11]=0,f.elements[15]=1),F.style.width=j.width+`px`,F.style.height=j.height+`px`,F.style.perspective=r?``:`${n}px`,B.current&&V.current&&(B.current.style.transform=`${d}${u}translate(${e}px,${t}px)`,V.current.style.transform=le(f,1/((c||10)/400)))}else{let t=c===void 0?1:oe(L.current,O)*c;F.style.transform=`translate3d(${e[0]}px,${e[1]}px,0) scale(${t})`}z.current=e,R.current=O.zoom}}if(!G&&U.current&&!W.current)if(u){if(B.current){let e=B.current.children[0];if(e!=null&&e.clientWidth&&e!=null&&e.clientHeight){let{isOrthographicCamera:t}=O;if(t||g)T.scale&&(Array.isArray(T.scale)?T.scale instanceof y?U.current.scale.copy(T.scale.clone().divideScalar(1)):U.current.scale.set(1/T.scale[0],1/T.scale[1],1/T.scale[2]):U.current.scale.setScalar(1/T.scale));else{let t=(c||10)/400,n=e.clientWidth*t,r=e.clientHeight*t;U.current.scale.set(n,r,1)}W.current=!0}}}else{let t=F.children[0];if(t!=null&&t.clientWidth&&t!=null&&t.clientHeight){let e=1/P.factor,n=t.clientWidth*e,r=t.clientHeight*e;U.current.scale.set(n,r,1),W.current=!0}U.current.lookAt(e.camera.position)}});let Y=w.useMemo(()=>({vertexShader:u?void 0:`
          /*
            This shader is from the THREE's SpriteMaterial.
            We need to turn the backing plane into a Sprite
            (make it always face the camera) if "transfrom"
            is false.
          */
          #include <common>

          void main() {
            vec2 center = vec2(0., 1.);
            float rotation = 0.0;

            // This is somewhat arbitrary, but it seems to work well
            // Need to figure out how to derive this dynamically if it even matters
            float size = 0.03;

            vec4 mvPosition = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
            vec2 scale;
            scale.x = length( vec3( modelMatrix[ 0 ].x, modelMatrix[ 0 ].y, modelMatrix[ 0 ].z ) );
            scale.y = length( vec3( modelMatrix[ 1 ].x, modelMatrix[ 1 ].y, modelMatrix[ 1 ].z ) );

            bool isPerspective = isPerspectiveMatrix( projectionMatrix );
            if ( isPerspective ) scale *= - mvPosition.z;

            vec2 alignedPosition = ( position.xy - ( center - vec2( 0.5 ) ) ) * scale * size;
            vec2 rotatedPosition;
            rotatedPosition.x = cos( rotation ) * alignedPosition.x - sin( rotation ) * alignedPosition.y;
            rotatedPosition.y = sin( rotation ) * alignedPosition.x + cos( rotation ) * alignedPosition.y;
            mvPosition.xy += rotatedPosition;

            gl_Position = projectionMatrix * mvPosition;
          }
      `,fragmentShader:`
        void main() {
          gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        }
      `}),[u]);return w.createElement(`group`,C({},T,{ref:L}),d&&!G&&w.createElement(`mesh`,{castShadow:p,receiveShadow:m,ref:U},g||w.createElement(`planeGeometry`,null),h||w.createElement(`shaderMaterial`,{side:2,vertexShader:Y.vertexShader,fragmentShader:Y.fragmentShader})))}),M=parseInt(`160`.replace(/\D+/g,``)),N=M>=125?`uv1`:`uv2`,P=new m,F=new y,I=class extends _{constructor(){super(),this.isLineSegmentsGeometry=!0,this.type=`LineSegmentsGeometry`,this.setIndex([0,2,1,2,3,1,2,4,3,4,5,3,4,6,5,6,7,5]),this.setAttribute(`position`,new a([-1,2,0,1,2,0,-1,1,0,1,1,0,-1,0,0,1,0,0,-1,-1,0,1,-1,0],3)),this.setAttribute(`uv`,new a([-1,2,1,2,-1,1,1,1,-1,-1,1,-1,-1,-2,1,-2],2))}applyMatrix4(e){let t=this.attributes.instanceStart,n=this.attributes.instanceEnd;return t!==void 0&&(t.applyMatrix4(e),n.applyMatrix4(e),t.needsUpdate=!0),this.boundingBox!==null&&this.computeBoundingBox(),this.boundingSphere!==null&&this.computeBoundingSphere(),this}setPositions(e){let t;e instanceof Float32Array?t=e:Array.isArray(e)&&(t=new Float32Array(e));let n=new r(t,6,1);return this.setAttribute(`instanceStart`,new c(n,3,0)),this.setAttribute(`instanceEnd`,new c(n,3,3)),this.computeBoundingBox(),this.computeBoundingSphere(),this}setColors(e,t=3){let n;e instanceof Float32Array?n=e:Array.isArray(e)&&(n=new Float32Array(e));let i=new r(n,t*2,1);return this.setAttribute(`instanceColorStart`,new c(i,t,0)),this.setAttribute(`instanceColorEnd`,new c(i,t,t)),this}fromWireframeGeometry(e){return this.setPositions(e.attributes.position.array),this}fromEdgesGeometry(e){return this.setPositions(e.attributes.position.array),this}fromMesh(e){return this.fromWireframeGeometry(new d(e.geometry)),this}fromLineSegments(e){let t=e.geometry;return this.setPositions(t.attributes.position.array),this}computeBoundingBox(){this.boundingBox===null&&(this.boundingBox=new m);let e=this.attributes.instanceStart,t=this.attributes.instanceEnd;e!==void 0&&t!==void 0&&(this.boundingBox.setFromBufferAttribute(e),P.setFromBufferAttribute(t),this.boundingBox.union(P))}computeBoundingSphere(){this.boundingSphere===null&&(this.boundingSphere=new l),this.boundingBox===null&&this.computeBoundingBox();let e=this.attributes.instanceStart,t=this.attributes.instanceEnd;if(e!==void 0&&t!==void 0){let n=this.boundingSphere.center;this.boundingBox.getCenter(n);let r=0;for(let i=0,a=e.count;i<a;i++)F.fromBufferAttribute(e,i),r=Math.max(r,n.distanceToSquared(F)),F.fromBufferAttribute(t,i),r=Math.max(r,n.distanceToSquared(F));this.boundingSphere.radius=Math.sqrt(r),isNaN(this.boundingSphere.radius)&&console.error(`THREE.LineSegmentsGeometry.computeBoundingSphere(): Computed radius is NaN. The instanced position data is likely to have NaN values.`,this)}}toJSON(){}applyMatrix(e){return console.warn(`THREE.LineSegmentsGeometry: applyMatrix() has been renamed to applyMatrix4().`),this.applyMatrix4(e)}},L=class extends I{constructor(){super(),this.isLineGeometry=!0,this.type=`LineGeometry`}setPositions(e){let t=e.length-3,n=new Float32Array(2*t);for(let r=0;r<t;r+=3)n[2*r]=e[r],n[2*r+1]=e[r+1],n[2*r+2]=e[r+2],n[2*r+3]=e[r+3],n[2*r+4]=e[r+4],n[2*r+5]=e[r+5];return super.setPositions(n),this}setColors(e,t=3){let n=e.length-t,r=new Float32Array(2*n);if(t===3)for(let i=0;i<n;i+=t)r[2*i]=e[i],r[2*i+1]=e[i+1],r[2*i+2]=e[i+2],r[2*i+3]=e[i+3],r[2*i+4]=e[i+4],r[2*i+5]=e[i+5];else for(let i=0;i<n;i+=t)r[2*i]=e[i],r[2*i+1]=e[i+1],r[2*i+2]=e[i+2],r[2*i+3]=e[i+3],r[2*i+4]=e[i+4],r[2*i+5]=e[i+5],r[2*i+6]=e[i+6],r[2*i+7]=e[i+7];return super.setColors(r,t),this}fromLine(e){let t=e.geometry;return this.setPositions(t.attributes.position.array),this}},R=class extends i{constructor(e){super({type:`LineMaterial`,uniforms:p.clone(p.merge([f.common,f.fog,{worldUnits:{value:1},linewidth:{value:1},resolution:{value:new s(1,1)},dashOffset:{value:0},dashScale:{value:1},dashSize:{value:1},gapSize:{value:1}}])),vertexShader:`
				#include <common>
				#include <fog_pars_vertex>
				#include <logdepthbuf_pars_vertex>
				#include <clipping_planes_pars_vertex>

				uniform float linewidth;
				uniform vec2 resolution;

				attribute vec3 instanceStart;
				attribute vec3 instanceEnd;

				#ifdef USE_COLOR
					#ifdef USE_LINE_COLOR_ALPHA
						varying vec4 vLineColor;
						attribute vec4 instanceColorStart;
						attribute vec4 instanceColorEnd;
					#else
						varying vec3 vLineColor;
						attribute vec3 instanceColorStart;
						attribute vec3 instanceColorEnd;
					#endif
				#endif

				#ifdef WORLD_UNITS

					varying vec4 worldPos;
					varying vec3 worldStart;
					varying vec3 worldEnd;

					#ifdef USE_DASH

						varying vec2 vUv;

					#endif

				#else

					varying vec2 vUv;

				#endif

				#ifdef USE_DASH

					uniform float dashScale;
					attribute float instanceDistanceStart;
					attribute float instanceDistanceEnd;
					varying float vLineDistance;

				#endif

				void trimSegment( const in vec4 start, inout vec4 end ) {

					// trim end segment so it terminates between the camera plane and the near plane

					// conservative estimate of the near plane
					float a = projectionMatrix[ 2 ][ 2 ]; // 3nd entry in 3th column
					float b = projectionMatrix[ 3 ][ 2 ]; // 3nd entry in 4th column
					float nearEstimate = - 0.5 * b / a;

					float alpha = ( nearEstimate - start.z ) / ( end.z - start.z );

					end.xyz = mix( start.xyz, end.xyz, alpha );

				}

				void main() {

					#ifdef USE_COLOR

						vLineColor = ( position.y < 0.5 ) ? instanceColorStart : instanceColorEnd;

					#endif

					#ifdef USE_DASH

						vLineDistance = ( position.y < 0.5 ) ? dashScale * instanceDistanceStart : dashScale * instanceDistanceEnd;
						vUv = uv;

					#endif

					float aspect = resolution.x / resolution.y;

					// camera space
					vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );
					vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );

					#ifdef WORLD_UNITS

						worldStart = start.xyz;
						worldEnd = end.xyz;

					#else

						vUv = uv;

					#endif

					// special case for perspective projection, and segments that terminate either in, or behind, the camera plane
					// clearly the gpu firmware has a way of addressing this issue when projecting into ndc space
					// but we need to perform ndc-space calculations in the shader, so we must address this issue directly
					// perhaps there is a more elegant solution -- WestLangley

					bool perspective = ( projectionMatrix[ 2 ][ 3 ] == - 1.0 ); // 4th entry in the 3rd column

					if ( perspective ) {

						if ( start.z < 0.0 && end.z >= 0.0 ) {

							trimSegment( start, end );

						} else if ( end.z < 0.0 && start.z >= 0.0 ) {

							trimSegment( end, start );

						}

					}

					// clip space
					vec4 clipStart = projectionMatrix * start;
					vec4 clipEnd = projectionMatrix * end;

					// ndc space
					vec3 ndcStart = clipStart.xyz / clipStart.w;
					vec3 ndcEnd = clipEnd.xyz / clipEnd.w;

					// direction
					vec2 dir = ndcEnd.xy - ndcStart.xy;

					// account for clip-space aspect ratio
					dir.x *= aspect;
					dir = normalize( dir );

					#ifdef WORLD_UNITS

						// get the offset direction as perpendicular to the view vector
						vec3 worldDir = normalize( end.xyz - start.xyz );
						vec3 offset;
						if ( position.y < 0.5 ) {

							offset = normalize( cross( start.xyz, worldDir ) );

						} else {

							offset = normalize( cross( end.xyz, worldDir ) );

						}

						// sign flip
						if ( position.x < 0.0 ) offset *= - 1.0;

						float forwardOffset = dot( worldDir, vec3( 0.0, 0.0, 1.0 ) );

						// don't extend the line if we're rendering dashes because we
						// won't be rendering the endcaps
						#ifndef USE_DASH

							// extend the line bounds to encompass  endcaps
							start.xyz += - worldDir * linewidth * 0.5;
							end.xyz += worldDir * linewidth * 0.5;

							// shift the position of the quad so it hugs the forward edge of the line
							offset.xy -= dir * forwardOffset;
							offset.z += 0.5;

						#endif

						// endcaps
						if ( position.y > 1.0 || position.y < 0.0 ) {

							offset.xy += dir * 2.0 * forwardOffset;

						}

						// adjust for linewidth
						offset *= linewidth * 0.5;

						// set the world position
						worldPos = ( position.y < 0.5 ) ? start : end;
						worldPos.xyz += offset;

						// project the worldpos
						vec4 clip = projectionMatrix * worldPos;

						// shift the depth of the projected points so the line
						// segments overlap neatly
						vec3 clipPose = ( position.y < 0.5 ) ? ndcStart : ndcEnd;
						clip.z = clipPose.z * clip.w;

					#else

						vec2 offset = vec2( dir.y, - dir.x );
						// undo aspect ratio adjustment
						dir.x /= aspect;
						offset.x /= aspect;

						// sign flip
						if ( position.x < 0.0 ) offset *= - 1.0;

						// endcaps
						if ( position.y < 0.0 ) {

							offset += - dir;

						} else if ( position.y > 1.0 ) {

							offset += dir;

						}

						// adjust for linewidth
						offset *= linewidth;

						// adjust for clip-space to screen-space conversion // maybe resolution should be based on viewport ...
						offset /= resolution.y;

						// select end
						vec4 clip = ( position.y < 0.5 ) ? clipStart : clipEnd;

						// back to clip space
						offset *= clip.w;

						clip.xy += offset;

					#endif

					gl_Position = clip;

					vec4 mvPosition = ( position.y < 0.5 ) ? start : end; // this is an approximation

					#include <logdepthbuf_vertex>
					#include <clipping_planes_vertex>
					#include <fog_vertex>

				}
			`,fragmentShader:`
				uniform vec3 diffuse;
				uniform float opacity;
				uniform float linewidth;

				#ifdef USE_DASH

					uniform float dashOffset;
					uniform float dashSize;
					uniform float gapSize;

				#endif

				varying float vLineDistance;

				#ifdef WORLD_UNITS

					varying vec4 worldPos;
					varying vec3 worldStart;
					varying vec3 worldEnd;

					#ifdef USE_DASH

						varying vec2 vUv;

					#endif

				#else

					varying vec2 vUv;

				#endif

				#include <common>
				#include <fog_pars_fragment>
				#include <logdepthbuf_pars_fragment>
				#include <clipping_planes_pars_fragment>

				#ifdef USE_COLOR
					#ifdef USE_LINE_COLOR_ALPHA
						varying vec4 vLineColor;
					#else
						varying vec3 vLineColor;
					#endif
				#endif

				vec2 closestLineToLine(vec3 p1, vec3 p2, vec3 p3, vec3 p4) {

					float mua;
					float mub;

					vec3 p13 = p1 - p3;
					vec3 p43 = p4 - p3;

					vec3 p21 = p2 - p1;

					float d1343 = dot( p13, p43 );
					float d4321 = dot( p43, p21 );
					float d1321 = dot( p13, p21 );
					float d4343 = dot( p43, p43 );
					float d2121 = dot( p21, p21 );

					float denom = d2121 * d4343 - d4321 * d4321;

					float numer = d1343 * d4321 - d1321 * d4343;

					mua = numer / denom;
					mua = clamp( mua, 0.0, 1.0 );
					mub = ( d1343 + d4321 * ( mua ) ) / d4343;
					mub = clamp( mub, 0.0, 1.0 );

					return vec2( mua, mub );

				}

				void main() {

					#include <clipping_planes_fragment>

					#ifdef USE_DASH

						if ( vUv.y < - 1.0 || vUv.y > 1.0 ) discard; // discard endcaps

						if ( mod( vLineDistance + dashOffset, dashSize + gapSize ) > dashSize ) discard; // todo - FIX

					#endif

					float alpha = opacity;

					#ifdef WORLD_UNITS

						// Find the closest points on the view ray and the line segment
						vec3 rayEnd = normalize( worldPos.xyz ) * 1e5;
						vec3 lineDir = worldEnd - worldStart;
						vec2 params = closestLineToLine( worldStart, worldEnd, vec3( 0.0, 0.0, 0.0 ), rayEnd );

						vec3 p1 = worldStart + lineDir * params.x;
						vec3 p2 = rayEnd * params.y;
						vec3 delta = p1 - p2;
						float len = length( delta );
						float norm = len / linewidth;

						#ifndef USE_DASH

							#ifdef USE_ALPHA_TO_COVERAGE

								float dnorm = fwidth( norm );
								alpha = 1.0 - smoothstep( 0.5 - dnorm, 0.5 + dnorm, norm );

							#else

								if ( norm > 0.5 ) {

									discard;

								}

							#endif

						#endif

					#else

						#ifdef USE_ALPHA_TO_COVERAGE

							// artifacts appear on some hardware if a derivative is taken within a conditional
							float a = vUv.x;
							float b = ( vUv.y > 0.0 ) ? vUv.y - 1.0 : vUv.y + 1.0;
							float len2 = a * a + b * b;
							float dlen = fwidth( len2 );

							if ( abs( vUv.y ) > 1.0 ) {

								alpha = 1.0 - smoothstep( 1.0 - dlen, 1.0 + dlen, len2 );

							}

						#else

							if ( abs( vUv.y ) > 1.0 ) {

								float a = vUv.x;
								float b = ( vUv.y > 0.0 ) ? vUv.y - 1.0 : vUv.y + 1.0;
								float len2 = a * a + b * b;

								if ( len2 > 1.0 ) discard;

							}

						#endif

					#endif

					vec4 diffuseColor = vec4( diffuse, alpha );
					#ifdef USE_COLOR
						#ifdef USE_LINE_COLOR_ALPHA
							diffuseColor *= vLineColor;
						#else
							diffuseColor.rgb *= vLineColor;
						#endif
					#endif

					#include <logdepthbuf_fragment>

					gl_FragColor = diffuseColor;

					#include <tonemapping_fragment>
					#include <${M>=154?`colorspace_fragment`:`encodings_fragment`}>
					#include <fog_fragment>
					#include <premultiplied_alpha_fragment>

				}
			`,clipping:!0}),this.isLineMaterial=!0,this.onBeforeCompile=function(){this.transparent?this.defines.USE_LINE_COLOR_ALPHA=`1`:delete this.defines.USE_LINE_COLOR_ALPHA},Object.defineProperties(this,{color:{enumerable:!0,get:function(){return this.uniforms.diffuse.value},set:function(e){this.uniforms.diffuse.value=e}},worldUnits:{enumerable:!0,get:function(){return`WORLD_UNITS`in this.defines},set:function(e){e===!0?this.defines.WORLD_UNITS=``:delete this.defines.WORLD_UNITS}},linewidth:{enumerable:!0,get:function(){return this.uniforms.linewidth.value},set:function(e){this.uniforms.linewidth.value=e}},dashed:{enumerable:!0,get:function(){return`USE_DASH`in this.defines},set(e){!!e!=`USE_DASH`in this.defines&&(this.needsUpdate=!0),e===!0?this.defines.USE_DASH=``:delete this.defines.USE_DASH}},dashScale:{enumerable:!0,get:function(){return this.uniforms.dashScale.value},set:function(e){this.uniforms.dashScale.value=e}},dashSize:{enumerable:!0,get:function(){return this.uniforms.dashSize.value},set:function(e){this.uniforms.dashSize.value=e}},dashOffset:{enumerable:!0,get:function(){return this.uniforms.dashOffset.value},set:function(e){this.uniforms.dashOffset.value=e}},gapSize:{enumerable:!0,get:function(){return this.uniforms.gapSize.value},set:function(e){this.uniforms.gapSize.value=e}},opacity:{enumerable:!0,get:function(){return this.uniforms.opacity.value},set:function(e){this.uniforms.opacity.value=e}},resolution:{enumerable:!0,get:function(){return this.uniforms.resolution.value},set:function(e){this.uniforms.resolution.value.copy(e)}},alphaToCoverage:{enumerable:!0,get:function(){return`USE_ALPHA_TO_COVERAGE`in this.defines},set:function(e){!!e!=`USE_ALPHA_TO_COVERAGE`in this.defines&&(this.needsUpdate=!0),e===!0?(this.defines.USE_ALPHA_TO_COVERAGE=``,this.extensions.derivatives=!0):(delete this.defines.USE_ALPHA_TO_COVERAGE,this.extensions.derivatives=!1)}}}),this.setValues(e)}},z=new o,B=new y,V=new y,H=new o,U=new o,W=new o,G=new y,K=new h,q=new x,J=new y,Y=new m,X=new l,Z=new o,Q,$;function de(e,t,n){return Z.set(0,0,-t,1).applyMatrix4(e.projectionMatrix),Z.multiplyScalar(1/Z.w),Z.x=$/n.width,Z.y=$/n.height,Z.applyMatrix4(e.projectionMatrixInverse),Z.multiplyScalar(1/Z.w),Math.abs(Math.max(Z.x,Z.y))}function fe(e,t){let n=e.matrixWorld,r=e.geometry,i=r.attributes.instanceStart,a=r.attributes.instanceEnd,o=Math.min(r.instanceCount,i.count);for(let r=0,s=o;r<s;r++){q.start.fromBufferAttribute(i,r),q.end.fromBufferAttribute(a,r),q.applyMatrix4(n);let o=new y,s=new y;Q.distanceSqToSegment(q.start,q.end,s,o),s.distanceTo(o)<$*.5&&t.push({point:s,pointOnLine:o,distance:Q.origin.distanceTo(s),object:e,face:null,faceIndex:r,uv:null,[N]:null})}}function pe(e,t,n){let r=t.projectionMatrix,i=e.material.resolution,a=e.matrixWorld,o=e.geometry,s=o.attributes.instanceStart,c=o.attributes.instanceEnd,l=Math.min(o.instanceCount,s.count),d=-t.near;Q.at(1,W),W.w=1,W.applyMatrix4(t.matrixWorldInverse),W.applyMatrix4(r),W.multiplyScalar(1/W.w),W.x*=i.x/2,W.y*=i.y/2,W.z=0,G.copy(W),K.multiplyMatrices(t.matrixWorldInverse,a);for(let t=0,o=l;t<o;t++){if(H.fromBufferAttribute(s,t),U.fromBufferAttribute(c,t),H.w=1,U.w=1,H.applyMatrix4(K),U.applyMatrix4(K),H.z>d&&U.z>d)continue;if(H.z>d){let e=H.z-U.z,t=(H.z-d)/e;H.lerp(U,t)}else if(U.z>d){let e=U.z-H.z,t=(U.z-d)/e;U.lerp(H,t)}H.applyMatrix4(r),U.applyMatrix4(r),H.multiplyScalar(1/H.w),U.multiplyScalar(1/U.w),H.x*=i.x/2,H.y*=i.y/2,U.x*=i.x/2,U.y*=i.y/2,q.start.copy(H),q.start.z=0,q.end.copy(U),q.end.z=0;let o=q.closestPointToPointParameter(G,!0);q.at(o,J);let l=u.lerp(H.z,U.z,o),f=l>=-1&&l<=1,p=G.distanceTo(J)<$*.5;if(f&&p){q.start.fromBufferAttribute(s,t),q.end.fromBufferAttribute(c,t),q.start.applyMatrix4(a),q.end.applyMatrix4(a);let r=new y,i=new y;Q.distanceSqToSegment(q.start,q.end,i,r),n.push({point:i,pointOnLine:r,distance:Q.origin.distanceTo(i),object:e,face:null,faceIndex:t,uv:null,[N]:null})}}}var me=class extends b{constructor(e=new I,t=new R({color:Math.random()*16777215})){super(e,t),this.isLineSegments2=!0,this.type=`LineSegments2`}computeLineDistances(){let e=this.geometry,t=e.attributes.instanceStart,n=e.attributes.instanceEnd,i=new Float32Array(2*t.count);for(let e=0,r=0,a=t.count;e<a;e++,r+=2)B.fromBufferAttribute(t,e),V.fromBufferAttribute(n,e),i[r]=r===0?0:i[r-1],i[r+1]=i[r]+B.distanceTo(V);let a=new r(i,2,1);return e.setAttribute(`instanceDistanceStart`,new c(a,1,0)),e.setAttribute(`instanceDistanceEnd`,new c(a,1,1)),this}raycast(e,t){let n=this.material.worldUnits,r=e.camera;r===null&&!n&&console.error(`LineSegments2: "Raycaster.camera" needs to be set in order to raycast against LineSegments2 while worldUnits is set to false.`);let i=e.params.Line2===void 0?0:e.params.Line2.threshold||0;Q=e.ray;let a=this.matrixWorld,o=this.geometry,s=this.material;$=s.linewidth+i,o.boundingSphere===null&&o.computeBoundingSphere(),X.copy(o.boundingSphere).applyMatrix4(a);let c;if(c=n?$*.5:de(r,Math.max(r.near,X.distanceToPoint(Q.origin)),s.resolution),X.radius+=c,Q.intersectsSphere(X)===!1)return;o.boundingBox===null&&o.computeBoundingBox(),Y.copy(o.boundingBox).applyMatrix4(a);let l;l=n?$*.5:de(r,Math.max(r.near,Y.distanceToPoint(Q.origin)),s.resolution),Y.expandByScalar(l),Q.intersectsBox(Y)!==!1&&(n?fe(this,t):pe(this,r,t))}onBeforeRender(e){let t=this.material.uniforms;t&&t.resolution&&(e.getViewport(z),this.material.uniforms.resolution.value.set(z.z,z.w))}},he=class extends me{constructor(e=new L,t=new R({color:Math.random()*16777215})){super(e,t),this.isLine2=!0,this.type=`Line2`}},ge=w.forwardRef(function({points:e,color:t=16777215,vertexColors:n,linewidth:r,lineWidth:i,segments:a,dashed:c,...l},u){var d;let f=S(e=>e.size),p=w.useMemo(()=>a?new me:new he,[a]),[m]=w.useState(()=>new R),h=(n==null||(d=n[0])==null?void 0:d.length)===4?4:3,g=w.useMemo(()=>{let r=a?new I:new L,i=e.map(e=>{let t=Array.isArray(e);return e instanceof y||e instanceof o?[e.x,e.y,e.z]:e instanceof s?[e.x,e.y,0]:t&&e.length===3?[e[0],e[1],e[2]]:t&&e.length===2?[e[0],e[1],0]:e});if(r.setPositions(i.flat()),n){t=16777215;let e=n.map(e=>e instanceof ee?e.toArray():e);r.setColors(e.flat(),h)}return r},[e,a,n,h]);return w.useLayoutEffect(()=>{p.computeLineDistances()},[e,p]),w.useLayoutEffect(()=>{c?m.defines.USE_DASH=``:delete m.defines.USE_DASH,m.needsUpdate=!0},[c,m]),w.useEffect(()=>()=>{g.dispose(),m.dispose()},[g]),w.createElement(`primitive`,C({object:p,ref:u},l),w.createElement(`primitive`,{object:g,attach:`geometry`}),w.createElement(`primitive`,C({object:m,attach:`material`,color:t,vertexColors:!!n,resolution:[f.width,f.height],linewidth:r??i??1,dashed:c,transparent:h===4},l)))});export{j as n,C as r,ge as t};