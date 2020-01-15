import { Component } from './component';
import { Connection } from './connection';
import { Context } from './core/context';
import { Data } from './core/data';
import { EditorView } from './view/index';
import { Input } from './input';
import { Node } from './node';
import { Output } from './output';
import { Selected } from './selected';
import { Validator } from './core/validator';
import { EditorEvents, EventsTypes } from './events';

export class NodeEditor extends Context<EventsTypes> {

    nodes: Node[] = [];
    selected = new Selected();
    view: EditorView;

    constructor(id: string, container: HTMLElement) {
        super(id, new EditorEvents());

        this.view = new EditorView(container, this.components, this);

        container.setAttribute('tabindex', '-1'); // make element focusable so it receives key events
        container.addEventListener('keydown', e => this.trigger('keydown', e));
        container.addEventListener('keyup', e => this.trigger('keyup', e));

        this.on('selectnode', ({ node, accumulate }) => this.selectNode(node, accumulate));
        this.on('nodeselected', () => this.selected.each(n => {
            const nodeView = this.view.nodes.get(n);

            nodeView && nodeView.onStart()
        }));
        this.on('translatenode', ({ dx, dy }) => this.selected.each(n => {
            const nodeView = this.view.nodes.get(n);

            nodeView && nodeView.onDrag(dx, dy)
        }));
    }

    addNode(node: Node) {
        if (!this.trigger('nodecreate', node)) return;

        this.nodes.push(node);
        this.view.addNode(node);
        
        this.trigger('nodecreated', node);
    }

    removeNode(node: Node) {
        if (!this.trigger('noderemove', node)) return;

        node.getConnections().forEach(c => this.removeConnection(c));

        this.nodes.splice(this.nodes.indexOf(node), 1);
        this.view.removeNode(node);

        this.trigger('noderemoved', node);
    }

    connect(output: Output, input: Input, data: unknown = {}) {
        if (!this.trigger('connectioncreate', { output, input })) return;

        try {
            const connection = output.connectTo(input);

            connection.data = data;
            this.view.addConnection(connection);

            this.trigger('connectioncreated', connection);
        } catch (e) {
            this.trigger('warn', e)
        }
    }

    removeConnection(connection: Connection) {
        if (!this.trigger('connectionremove', connection)) return;
            
        this.view.removeConnection(connection);
        connection.remove();

        this.trigger('connectionremoved', connection);
    }

    selectNode(node: Node, accumulate: boolean = false) {
        if (this.nodes.indexOf(node) === -1) 
            throw new Error('Node not exist in list');
        
        if (!this.trigger('nodeselect', node)) return;

        if (!accumulate) {
            const prevSelected = this.selected.list;

            // Must clear the selection before triggering 'nodedeselected' so that the handlers observe the deselection.
            this.selected.clear();
            prevSelected.forEach(prevNode => this.trigger('nodedeselected', prevNode));
        }
        if (!this.selected.list.includes(node)) {
            this.selected.list.push(node);
        }

        this.trigger('nodeselected', node);
    }

    deselectNode(node: Node) {
        if (this.nodes.indexOf(node) === -1) {
            throw new Error('The node does not belong to this editor')
        }
        if (!this.selected.contains(node)) {
            console.warn('Rete.js: NodeEditor.deselectNodes: The node', node, 'is not selected');
            return;
        }
        if (!this.trigger('nodedeselect', node)) {
            return;
        }
        this.selected.remove(node);
        this.trigger('nodedeselected', node);
    }

    toggleNodeSelection(node: Node) {
        if (this.nodes.indexOf(node) === -1) {
            throw new Error('The node does not belong to this editor');
        }
        if (this.selected.contains(node)) {
            this.deselectNode(node);
        } else {
            this.selectNode(node, true);
        }
    }

    getComponent(name: string) {
        const component = this.components.get(name);

        if (!component)
            throw `Component ${name} not found`;
        
        return component as Component;
    }

    register(component: Component) {
        super.register(component)
        component.editor = this;
    }

    clear() {
        [...this.nodes].forEach(node => this.removeNode(node));
        this.trigger('clear');
    }

    toJSON() {
        const data: Data = { id: this.id, nodes: {} };
        
        this.nodes.forEach(node => data.nodes[node.id] = node.toJSON());
        this.trigger('export', data);
        return data;
    }

    beforeImport(json: Data) {
        const checking = Validator.validate(this.id, json);
        
        if (!checking.success) {
            this.trigger('warn', checking.msg);
            return false;
        }
        
        this.silent = true;
        this.clear();
        this.trigger('import', json);
        return true;
    }

    afterImport() {
        this.silent = false;
        return true;
    }

    async fromJSON(json: Data) {
        if (!this.beforeImport(json)) return false;
        const nodes: {[key: string]: Node} = {};

        try {
            await Promise.all(Object.keys(json.nodes).map(async id => {
                const node = json.nodes[id];
                const component = this.getComponent(node.name);

                nodes[id] = await component.build(Node.fromJSON(node));
                this.addNode(nodes[id]);
            }));
        
            Object.keys(json.nodes).forEach(id => {
                const jsonNode = json.nodes[id];
                const node = nodes[id];
                
                Object.keys(jsonNode.outputs).forEach(key => {
                    const outputJson = jsonNode.outputs[key];

                    outputJson.connections.forEach(jsonConnection => {
                        const nodeId = jsonConnection.node;
                        const data = jsonConnection.data;
                        const targetOutput = node.outputs.get(key);
                        const targetInput = nodes[nodeId].inputs.get(jsonConnection.input);

                        if (!targetOutput || !targetInput) {
                            return this.trigger('error', `IO not found for node ${node.id}`);
                        }

                        this.connect(targetOutput, targetInput, data);
                    });
                });

            });
        } catch (e) {
            this.trigger('warn', e);
            return !this.afterImport();
        }

        return this.afterImport();
    }
}
