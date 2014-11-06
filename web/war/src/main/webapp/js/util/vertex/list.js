
define([
    'flight/lib/component',
    'flight/lib/registry',
    'data',
    'tpl!./list',
    'tpl!./item',
    'tpl!util/alert',
    'promise!util/service/ontologyPromise',
    'util/deferredImage',
    'util/video/scrubber',
    'util/vertex/formatters',
    'util/popovers/withElementScrollingPositionUpdates',
    'util/jquery.withinScrollable',
    'util/jquery.ui.draggable.multiselect'
], function(
    defineComponent,
    registry,
    appData,
    template,
    vertexTemplate,
    alertTemplate,
    ontologyPromise,
    deferredImage,
    VideoScrubber,
    F,
    withPositionUpdates) {
    'use strict';

    return defineComponent(List, withPositionUpdates);

    function List() {

        this.defaultAttrs({
            itemSelector: '.vertex-item',
            infiniteScrolling: false
        });

        this.stateForVertex = function(vertex) {
            var inWorkspace = false; //appData.inWorkspace(vertex);
            return {
                inGraph: inWorkspace,
                inMap: inWorkspace && _.some(vertex.properties, function(p) {
                    var ontologyProperty = ontologyPromise.propertiesByTitle[p.name];
                    return ontologyProperty && ontologyProperty.dataType === 'geoLocation';
                })
            };
        };

        this.vertexIdToClassName = function(id) {
            var className = this.classNameLookup[id] = (this.classNameLookup[id] || ('vId' + (++this.classNameIndex)));
            return className;
        };

        this.classNameMapForVertices = function(vertices) {
            var self = this,
                classNamesForVertex = {};

            vertices.forEach(function(v) {

                var className = self.vertexIdToClassName(v.id),
                    classes = [className],
                    vertexState = self.stateForVertex(v);

                if (vertexState.inGraph) classes.push('graph-displayed');
                if (vertexState.inMap) classes.push('map-displayed');

                if (!v.imageSrcIsFromConcept) {
                    classes.push('non_concept_preview');
                }

                if (self.attr.relationDirections && v.id in self.attr.relationDirections) {
                    classes.push(self.attr.relationDirections[v.id]);
                }

                classNamesForVertex[v.id] = classes.join(' ');
            });

            return classNamesForVertex;
        };

        this.after('initialize', function() {
            var self = this;

            this.classNameIndex = 0;
            this.classNameLookup = {};

            this.$node
                .addClass('vertex-list')
                .html(template({
                    vertices: this.attr.vertices,
                    infiniteScrolling: this.attr.infiniteScrolling && this.attr.total !== this.attr.vertices.length,
                    classNamesForVertex: this.classNameMapForVertices(this.attr.vertices),
                    F: F
                }));

            this.attachEvents();

            this.loadVisibleResultPreviews = _.debounce(this.loadVisibleResultPreviews.bind(this), 1000);
            this.loadVisibleResultPreviews();

            this.triggerInfiniteScrollRequest = _.debounce(this.triggerInfiniteScrollRequest.bind(this), 1000);
            this.triggerInfiniteScrollRequest();

            this.setupDraggables();

            this.onObjectsSelected(null, { edges: [], vertices: appData.selectedVertices});

            this.on('selectAll', this.onSelectAll);
            this.on('down', this.move);
            this.on('up', this.move);
            this.on('contextmenu', this.onContextMenu);

            _.defer(function() {
                this.$node.scrollTop(0);
            }.bind(this))
        });

        this.onContextMenu = function(event) {
            var $target = $(event.target).closest('.vertex-item'),
                vertexId = $target.data('vertexId');

            event.preventDefault();
            event.stopPropagation();

            this.trigger($target, 'showVertexContextMenu', {
                vertexId: vertexId,
                position: {
                    x: event.pageX,
                    y: event.pageY
                }
            });
        };

        this.move = function(e, data) {
            var previousSelected = this.$node.find('.active')[e.type === 'up' ? 'first' : 'last'](),
                moveTo = previousSelected[e.type === 'up' ? 'prev' : 'next']('.vertex-item');

            if (moveTo.length) {

                var selected = [];

                if (data.shiftKey) {
                    selected = selected.concat(appData.selectedVertices);
                    selected.push(appData.vertex(moveTo.data('vertexId')));
                } else {
                    selected.push(appData.vertex(moveTo.data('vertexId')));
                }

                this.trigger(document, 'defocusVertices');
                this.trigger('selectObjects', { vertices: selected });
            }
        };

        this.onSelectAll = function(e) {
            e.stopPropagation();

            var items = this.$node.find('.vertex-item').addClass('active');
            this.selectItems(items);
        };

        this.after('teardown', function() {
            this.$node.off('mouseenter mouseleave');
            this.scrollNode.off('scroll.vertexList');
            this.$node.empty();
        });

        this.attachEvents = function() {
            this.scrollNode = this.$node;
            while (this.scrollNode.length && this.scrollNode.css('overflow') !== 'auto') {
                this.scrollNode = this.scrollNode.parent();
            }
            this.scrollNode.on('scroll.vertexList', this.onResultsScroll.bind(this));

            this.$node.on('mouseenter mouseleave', '.vertex-item', this.onHoverItem.bind(this));

            this.on(document, 'verticesAdded', this.onVerticesUpdated);
            this.on(document, 'verticesUpdated', this.onVerticesUpdated);
            this.on(document, 'verticesDeleted', this.onVerticesDeleted);
            this.on(document, 'objectsSelected', this.onObjectsSelected);
            this.on(document, 'switchWorkspace', this.onWorkspaceClear);
            this.on(document, 'workspaceDeleted', this.onWorkspaceClear);
            this.on(document, 'workspaceLoaded', this.onWorkspaceLoaded);
            this.on('addInfiniteVertices', this.onAddInfiniteVertices);
        };

        this.setupDraggables = function() {
            this.applyDraggable(this.$node.find('a'));
            this.$node.droppable({ accept: '*', tolerance: 'pointer' });
        };

        this.onHoverItem = function(evt) {
            if (this.disableHover === 'defocused') {
                return;
            } else if (this.disableHover) {
                this.disableHover = 'defocused';
                return this.trigger(document, 'defocusVertices');
            }

            var id = $(evt.target).closest('.vertex-item').data('vertexId');
            if (evt.type == 'mouseenter' && id) {
                this.trigger(document, 'focusVertices', { vertexIds: [id] });
            } else {
                this.trigger(document, 'defocusVertices');
            }
        };

        this.onResultsScroll = function(e) {
            if (!this.disableHover) {
                this.disableHover = true;
            }

            this.loadVisibleResultPreviews();

            if (this.attr.infiniteScrolling) {
                this.triggerInfiniteScrollRequest();
            }
        };

        this.triggerInfiniteScrollRequest = function() {
            if (!this.attr.infiniteScrolling) return;

            var loadingListElement = this.$node.find('.infinite-loading');

            if (this.scrollNode.length) {
                loadingListElement = loadingListElement.withinScrollable(this.scrollNode);
            }

            if (loadingListElement.length) {
                var data = { conceptType: this.attr.verticesConceptId };
                if (!this.offset) this.offset = this.attr.nextOffset;
                data.paging = {
                    offset: this.offset,
                };
                this.trigger('infiniteScrollRequest', data);
            }
        };

        this.onAddInfiniteVertices = function(evt, data) {
            var loading = this.$node.find('.infinite-loading');

            if (!data.success) {
                loading.html(alertTemplate({
                    error: i18n('vertex.list.infinite_scroll.error')
                }));
                this.attr.infiniteScrolling = false;
            } else if (data.vertices.length === 0) {
                loading.remove();
                this.attr.infiniteScrolling = false;
            } else {
                this.offset = data.nextOffset;
                var clsMap = this.classNameMapForVertices(data.vertices),
                    added = data.vertices.map(function(vertex) {
                        return vertexTemplate({
                            vertex: vertex,
                            classNamesForVertex: clsMap,
                            F: F
                        });
                    }),
                    lastItem = loading.prev();

                loading.before(added);

                var total = data.total || this.attr.total || 0;
                if (total === this.$node.find('.vertex-item').length) {
                    loading.remove();
                    this.attr.infiniteScrolling = false;
                } else {
                    this.triggerInfiniteScrollRequest();
                }

                this.loadVisibleResultPreviews();

                this.applyDraggable(this.$node.find('a'));
            }
        };

        this.loadVisibleResultPreviews = function() {
            var self = this;

            this.disableHover = false;

            var lisVisible = this.$node.find('.nav-list').children('li');
            if (this.scrollNode.length) {
                lisVisible = lisVisible.withinScrollable(this.scrollNode);
            }

            lisVisible.each(function() {
                var li = $(this),
                    vertex = appData.vertex(li.data('vertexId'));

                if (vertex && !li.data('previewLoaded')) {

                    var preview = li.data('previewLoaded', true)
                                    .find('.preview');

                    if (vertex.imageFramesSrc) {
                        VideoScrubber.attachTo(preview, {
                            posterFrameUrl: vertex.imageSrc,
                            videoPreviewImageUrl: vertex.imageFramesSrc
                        });
                    } else {
                        var conceptImage = vertex.concept.glyphIconHref,
                            clsName = 'non_concept_preview';

                        if ((preview.css('background-image') || '').indexOf(vertex.imageSrc) >= 0) {
                            return;
                        }

                        li.removeClass(clsName).addClass('loading');

                        deferredImage(conceptImage)
                            .always(function() {
                                preview.css('background-image', 'url(' + conceptImage + ')')
                            })
                            .done(function() {
                                if (conceptImage === vertex.imageSrc) {
                                    li.toggleClass(clsName, !vertex.imageSrcIsFromConcept).removeClass('loading');
                                } else {
                                    _.delay(function() {
                                        deferredImage(vertex.imageSrc).always(function() {
                                            preview.css('background-image', 'url(' + vertex.imageSrc + ')');
                                            li.toggleClass(clsName, !vertex.imageSrcIsFromConcept)
                                                .removeClass('loading');
                                        })
                                    }, 500);
                                }
                            });
                    }
                }
            });
        };

        this.applyDraggable = function(el) {
            var self = this;

            el.draggable({
                helper: 'clone',
                appendTo: 'body',
                revert: 'invalid',
                revertDuration: 250,
                scroll: false,
                zIndex: 100,
                distance: 10,
                multi: true,
                otherDraggablesClass: 'vertex-dragging',
                start: function(ev, ui) {
                    $(ui.helper).addClass('vertex-dragging');
                },
                selection: function(ev, ui) {
                    self.selectItems(ui.selected);
                }
            });
        };

        this.selectItems = function(items) {
            var vertices = appData.vertices(items.map(function() {
                    return $(this).data('vertexId');
                }).toArray());

            if (vertices.length > 1) {
                vertices.forEach(function(vertex) {
                    vertex.workspace = {
                        selected: true
                    };
                });
            }
            if (vertices.length === 0) {
                return;
            }
            this.trigger(document, 'defocusVertices');
            this.trigger('selectObjects', { vertices: vertices });
        };

        this.onWorkspaceLoaded = function(evt, workspace) {
            this.onVerticesUpdated(evt, workspace.data || {});
        };

        // Track changes to vertices so we display the "Displayed in Graph" icon
        // in search results
        this.toggleItemIcons = function(id, data) {
            this.$node
                .find('li.' + this.vertexIdToClassName(id))
                .toggleClass('graph-displayed', data.inGraph)
                .toggleClass('map-displayed', data.inMap);
        };

        // Switching workspaces should clear the icon state and vertices
        this.onWorkspaceClear = function() {
            this.$node.find('li.graph-displayed').removeClass('graph-displayed');
            this.$node.find('li.map-displayed').removeClass('map-displayed');
        };

        this.onVerticesUpdated = function(event, data) {
            var self = this;
            (data.vertices || []).forEach(function(vertex) {
                self.toggleItemIcons(vertex.id, self.stateForVertex(vertex));
                var li = self.$node.find('li.' + self.vertexIdToClassName(vertex.id)),
                    currentAnchor = li.children('a'),
                    newAnchor = $(vertexTemplate({
                        vertex: vertex,
                        classNamesForVertex: self.classNameMapForVertices([vertex]),
                        F: F
                    })).children('a'),
                    currentHtml = currentAnchor.html(),
                    src = vertex.imageSrc;

                li.toggleClass('non_concept_preview', !vertex.imageSrcIsFromConcept)
                    .toggleClass('has-subtitle', !!F.vertex.subtitle(vertex))
                    .toggleClass('has-timeSubtitle', !!F.vertex.time(vertex));

                if (currentAnchor.length) {
                    currentAnchor[0].normalize()
                    currentAnchor[0].childNodes[0].textContent = F.vertex.title(vertex);
                    currentAnchor.children('ul').replaceWith(newAnchor.children('ul'));
                    currentAnchor.find('.date').replaceWith(newAnchor.find('.date'));
                    currentAnchor.find('.source').replaceWith(newAnchor.find('.source'));
                    li.data('previewLoaded', null);
                }
            });

            this.loadVisibleResultPreviews();
        };

        this.onVerticesDeleted = function(event, data) {
            var self = this;
            (data.vertices || []).forEach(function(vertex) {
                self.toggleItemIcons(vertex.id, { inGraph: false, inMap: false });
            });
        };

        this.onObjectsSelected = function(event, data) {
            this.$node.find('.active').removeClass('active');

            var self = this,
                ids = _.chain(data.vertices)
                    .map(function(v) {
                        return '.' + self.vertexIdToClassName(v.id);
                    })
                    .value().join(',');

            $(ids, this.node).addClass('active');
        };
    }
});
